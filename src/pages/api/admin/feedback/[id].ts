import type { APIRoute } from 'astro';
import { checkAdminAccess } from '../../../../lib/admin/auth';
import { getRuntimeEnv } from '../../../../lib/assistant/runtime-env';
import { getServiceRoleSupabase } from '../../../../lib/server/service-role-supabase';

// Аналитика и админка, Этап 2 — PATCH /api/admin/feedback/[id]
// body: { status: 'new' | 'read' | 'archived' }
//
// Единственное разрешённое изменение из этого раздела — статус сообщения
// (см. ограничения ТЗ: без ответов пользователю, email-рассылок, чата,
// тикетной системы, назначений на сотрудников).

export const prerender = false;

const ALLOWED_STATUSES = ['new', 'read', 'archived'] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const PATCH: APIRoute = async ({ request, locals, params }) => {
  try {
    return await handleUpdateStatus(request, locals, params.id ?? '');
  } catch (err) {
    return json({ ok: false, error: 'Внутренняя ошибка', detail: String(err) }, 200);
  }
};

async function handleUpdateStatus(request: Request, locals: App.Locals, id: string): Promise<Response> {
  const access = await checkAdminAccess(request, locals);
  if (!access.ok) {
    return json({ ok: false, error: access.status === 401 ? 'Не авторизован' : 'Доступ запрещён' }, access.status);
  }

  if (!id) {
    return json({ ok: false, error: 'Не указан идентификатор сообщения' }, 200);
  }

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Некорректный запрос' }, 400);
  }

  if (!body.status || !(ALLOWED_STATUSES as readonly string[]).includes(body.status)) {
    return json({ ok: false, error: 'Недопустимый статус' }, 400);
  }
  const status: AllowedStatus = body.status as AllowedStatus;

  const env = getRuntimeEnv(locals);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return json({ ok: false, error: 'Изменение статуса временно недоступно' }, 200);
  }
  const admin = getServiceRoleSupabase(serviceRoleKey);

  const { error } = await admin.from('feedback_messages').update({ status }).eq('id', id);
  if (error) {
    return json({ ok: false, error: 'Не удалось обновить статус' }, 200);
  }

  return json({ ok: true, id, status });
};
