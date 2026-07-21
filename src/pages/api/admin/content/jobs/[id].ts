import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../lib/server/service-role-supabase";
import { normalizeJobDetail } from "vitaminia-shared/normalize-job.mjs";

// SEO/Контент, Этап 3 — GET /api/admin/content/jobs/[id]
// Полная карточка производства: сам job + история прогонов (content_job_runs,
// для "прозрачности" п.17 ТЗ) + собранные источники (content_sources).
//
// Багфикс «пустой экран при открытии производства» — см. normalize-job.ts:
// у старых jobs некоторые поля (напр. research_brief.redFlags) исторически
// могли сохраниться не массивом, из-за чего JobScreen падал на `.map()`.
// Нормализация — здесь, в ОДНОМ месте, а не разбросана по JSX.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const GET: APIRoute = async ({ request, locals, params }) => {
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

    const { data: runs } = await admin.from("content_job_runs").select("*").eq("job_id", id).order("started_at", { ascending: true });
    const { data: sources } = await admin.from("content_sources").select("*").eq("job_id", id).order("accessed_at", { ascending: false });

    return json({ ok: true, job: normalizeJobDetail(job), runs: runs ?? [], sources: sources ?? [] });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
