import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../../lib/server/service-role-supabase";

// ТЗ "Editorial Engine 2.0", п.7 "Карточка материала — Комментарии
// редактора" — POST /api/admin/content/jobs/[id]/notes { notes }.
// Свободный текст, который редактор оставляет себе/коллегам (миграция 018,
// content_jobs.editor_notes). Не путать с decision_reason (пишет система) и
// с revision-инструкцией для AI (временный текст, отправляется в модель).

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const id = params.id;
    if (!id) return json({ ok: false, error: "Не указан ID" }, 200);

    const body = await request.json().catch(() => null);
    const notes = typeof body?.notes === "string" ? body.notes.slice(0, 5000) : "";

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { error } = await admin
      .from("content_jobs")
      .update({ editor_notes: notes || null, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return json({ ok: false, error: "Не удалось сохранить заметку" }, 200);

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
