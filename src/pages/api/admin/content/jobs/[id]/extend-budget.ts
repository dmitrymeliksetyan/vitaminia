import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../../lib/server/service-role-supabase";
import { BUDGET_EXTENSION_STEP_USD } from "../../../../../../lib/content-editor/production-config";
import { normalizeJobDetail } from "vitaminia-shared/normalize-job.mjs";

// SEO/Контент, Этап 3.2 — POST /api/admin/content/jobs/[id]/extend-budget (п.6 ТЗ)
//
// Единственный способ снова разрешить AI-вызовы для job, остановленного
// по денежному лимиту (status='paused', stop_reason_code='hard_limit') —
// кнопка «Продолжить ещё на $0.50» на экране "Производство приостановлено".
// НИКАКОГО автоматического продолжения при лимите нет и не должно быть —
// это явное подтверждение администратора, поднимающее лимит ИМЕННО этого
// job (budget_limit_usd), не глобальную константу.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// current_stage → на какой ADVANCEABLE-статус вернуть job, чтобы /advance снова подхватил производство с того же места.
const STAGE_TO_STATUS: Record<string, string> = {
  research: "researching",
  draft: "drafting",
  medical_review: "medical_review",
  final_review: "final_review",
  seo_review: "seo_review",
};

export const POST: APIRoute = async ({ request, locals, params }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const id = params.id;
    if (!id) return json({ ok: false, error: "Не указан ID" }, 200);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data: job, error: jobError } = await admin.from("content_jobs").select("*").eq("id", id).single();
    if (jobError || !job) return json({ ok: false, error: "Задача не найдена" }, 200);

    if (job.status !== "paused" || job.stop_reason_code !== "hard_limit") {
      return json({ ok: false, error: "Задача не остановлена по денежному лимиту — продлевать бюджет не нужно" }, 200);
    }

    const newLimit = Number(job.budget_limit_usd ?? 1.25) + BUDGET_EXTENSION_STEP_USD;
    const nextStatus = STAGE_TO_STATUS[job.current_stage] ?? "needs_decision";

    await admin
      .from("content_jobs")
      .update({
        budget_limit_usd: newLimit,
        status: nextStatus,
        stop_reason_code: null,
        decision_reason: `Лимит увеличен администратором до $${newLimit.toFixed(2)} — производство продолжено.`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    const { data: updatedJob } = await admin.from("content_jobs").select("*").eq("id", id).single();
    return json({ ok: true, job: normalizeJobDetail(updatedJob) });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
