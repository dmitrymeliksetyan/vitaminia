import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../lib/server/service-role-supabase";

// SEO/Контент, Этап 2 — PATCH /api/admin/content/ideas/[id]
// Меняет только статус/приоритет уже добавленной темы (жизненный цикл:
// идея → проверено → готово к созданию → в работе → создано → отклонено).
// Никакой автогенерации статьи и никакой публикации "одной кнопкой" — это
// прямо исключено в п.9-11/22 ТЗ, здесь только смена метки.

export const prerender = false;

// SEO/Контент, Этап 2.1 — добавлено 'archived' (см. п.12 ТЗ, миграция
// content_ideas_lifecycle_and_reasons). Не меняет значение "created" — оно
// по-прежнему хранится как есть в БД, просто в UI подписано "Опубликована"
// (см. IDEA_STATUS_LABELS в ContentDashboard.tsx).
const STATUSES = ["idea", "checked", "ready", "in_progress", "created", "rejected", "archived"] as const;
const PRIORITIES = ["high", "medium", "low"] as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const PATCH: APIRoute = async ({ request, locals, params }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const id = params.id;
    if (!id) return json({ ok: false, error: "Не указан ID" }, 200);

    const body = await request.json().catch(() => null);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body?.status !== undefined) {
      if (!STATUSES.includes(body.status)) return json({ ok: false, error: "Некорректный статус" }, 200);
      patch.status = body.status;
    }
    if (body?.priority !== undefined) {
      if (!PRIORITIES.includes(body.priority)) return json({ ok: false, error: "Некорректный приоритет" }, 200);
      patch.priority = body.priority;
    }

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Очередь временно недоступна" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { error } = await admin.from("content_ideas").update(patch).eq("id", id);
    if (error) return json({ ok: false, error: "Не удалось обновить тему" }, 200);

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
