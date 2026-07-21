import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../../lib/server/service-role-supabase";
import { normalizeJobDetail } from "vitaminia-shared/normalize-job.mjs";

// Этап "Выделение AI Worker в отдельный независимый сервис".
//
// ПЕРЕДЕЛАНО: раньше этот роут синхронно вызывал Anthropic (runDraftStage) —
// SSR требовался ANTHROPIC_API_KEY. Теперь SSR только записывает задание в
// content_jobs.pending_revision_instruction и переводит job на 'draft'/
// 'drafting' — Worker подхватывает это поле в своём draft-обработчике (см.
// run-stage.ts в medizin-worker: читает pending_revision_instruction, сразу
// же его очищает, передаёт как revisionInstruction в runDraftStage и логирует
// запуск под stage='revision', как и раньше). SSR никогда не обращается к
// Anthropic напрямую.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const REVISABLE_STATUSES = ["needs_decision", "medical_review", "final_review", "seo_review"];

export const POST: APIRoute = async ({ request, locals, params }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const id = params.id;
    if (!id) return json({ ok: false, error: "Не указан ID" }, 200);

    const body = await request.json().catch(() => null);
    const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
    if (!instruction) return json({ ok: false, error: "Укажите задание для AI" }, 200);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data: job, error: jobError } = await admin.from("content_jobs").select("*").eq("id", id).single();
    if (jobError || !job) return json({ ok: false, error: "Задача не найдена" }, 200);
    if (!job.draft) return json({ ok: false, error: "У задачи ещё нет черновика — сначала нужно пройти этап «Черновик»" }, 200);
    if (!REVISABLE_STATUSES.includes(job.status)) {
      return json({ ok: false, error: `Задачу в статусе "${job.status}" нельзя доработать сейчас` }, 200);
    }

    // Чистый триггер: задание для AI сохраняется в БД, job возвращается на
    // 'draft' — Worker подхватит его в очередном опросе content_jobs (не
    // требует, чтобы Worker был запущен именно сейчас — задание подождёт).
    await admin
      .from("content_jobs")
      .update({
        pending_revision_instruction: instruction,
        status: "drafting",
        current_stage: "draft",
        fix_count: 0,
        decision_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    const { data: updatedJob } = await admin.from("content_jobs").select("*").eq("id", id).single();
    return json({ ok: true, job: normalizeJobDetail(updatedJob) });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
