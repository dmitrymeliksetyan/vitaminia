import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../lib/server/service-role-supabase";

// ТЗ "AI Platform 1.0 — Этап 1: Editorial Engine 2.0", п.1/5/9 — "Worker
// offline" должен быть видимой, понятной ошибкой, а не молчаливой остановкой
// производства. medizin-worker пишет глобальный heartbeat (таблица
// worker_heartbeat, миграция 018) на каждом цикле опроса (~5с), НЕЗАВИСИМО
// от того, обрабатывает ли он сейчас job — раньше такого сигнала не было
// вообще (см. Паспорт редакции, раздел "Фоновые процессы"). Порог "не
// отвечает" — намеренно щедрый (STALE_AFTER_MS ниже) относительно интервала
// опроса воркера (5с), чтобы не мигать "offline" на каждый обычный сетевой
// джиттер между сайтом и Supabase.
export const prerender = false;

const STALE_AFTER_MS = 60_000; // 12x интервал опроса воркера (5с) — с запасом

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data, error } = await admin.from("worker_heartbeat").select("*").eq("id", "main").maybeSingle();
    if (error) return json({ ok: false, error: "Не удалось получить статус воркера" }, 200);

    if (!data) {
      // Строки нет вообще — medizin-worker ни разу не запускался с момента
      // применения миграции 018 (или таблица пуста по другой причине). Это
      // тоже "offline", просто с другой причиной для UI.
      return json({ ok: true, online: false, reason: "never_started", lastSeenAt: null, workerId: null, startedAt: null });
    }

    const lastSeenMs = new Date(data.last_seen_at).getTime();
    const staleMs = Date.now() - lastSeenMs;
    const online = staleMs <= STALE_AFTER_MS;

    return json({
      ok: true,
      online,
      reason: online ? null : "stale_heartbeat",
      lastSeenAt: data.last_seen_at,
      staleMs,
      workerId: data.worker_id,
      startedAt: data.started_at,
      queueSize: data.queue_size,
    });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
