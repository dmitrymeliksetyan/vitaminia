import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../../lib/server/service-role-supabase";
import { markStaleRunningAsInterrupted } from "vitaminia-shared/strategy-run-lifecycle.mjs";

// SEO/Контент, Этап 3.1 — GET /api/admin/content/strategy/runs/[id]
// Полная карточка исследования, включая кандидатов (для экрана результатов, п.9-10 ТЗ).

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

    const { data: runRaw, error } = await admin.from("content_strategy_runs").select("*").eq("id", id).single();
    if (error || !runRaw) return json({ ok: false, error: "Исследование не найдено" }, 200);

    const run = await markStaleRunningAsInterrupted(admin, runRaw);
    return json({ ok: true, run });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
