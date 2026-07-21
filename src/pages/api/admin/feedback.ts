import type { APIRoute } from 'astro';
import { checkAdminAccess } from '../../../lib/admin/auth';
import { getRuntimeEnv } from '../../../lib/assistant/runtime-env';
import { getServiceRoleSupabase } from '../../../lib/server/service-role-supabase';
import { shortId } from '../../../lib/admin/user-status';

// Аналитика и админка, Этап 2 — GET /api/admin/feedback?status=&limit=&offset=
//
// feedback_messages УЖЕ имеет колонку status (миграция 004: 'new' | 'read'
// | 'replied' | 'archived') — миграция для статуса НЕ понадобилась (см.
// исследование перед реализацией). Эта админка использует только 3 из 4
// значений (new/read/archived — Новое/В работе/Закрыто), 'replied'
// зарезервировано на случай будущей функции ответов, здесь не выставляется.
//
// Явный allow-list полей в ответе (п.10 ТЗ) — namе/user_email/reply_email/
// user_agent НЕ входят в список того, что раздел "Обратная связь" должен
// показывать (см. п.6 ТЗ: дата, источник, текст, короткий ID или "аноним",
// статус) — сознательно не возвращаем их через API, даже раз они не
// медицинские: ТЗ перечисляет ровно то, что нужно показать.

export const prerender = false;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ALLOWED_STATUSES = ['new', 'read', 'archived'] as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    return await handleFeedbackList(request, locals);
  } catch (err) {
    return json({ ok: false, error: 'Внутренняя ошибка', detail: String(err) }, 200);
  }
};

async function handleFeedbackList(request: Request, locals: App.Locals): Promise<Response> {
  const access = await checkAdminAccess(request, locals);
  if (!access.ok) {
    return json({ ok: false, error: access.status === 401 ? 'Не авторизован' : 'Доступ запрещён' }, access.status);
  }

  const env = getRuntimeEnv(locals);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return json({ ok: false, error: 'Обратная связь временно недоступна' }, 200);
  }
  const admin = getServiceRoleSupabase(serviceRoleKey);

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  let query = admin
    .from('feedback_messages')
    .select('id, created_at, user_id, page_url, message, status', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (statusParam && (ALLOWED_STATUSES as readonly string[]).includes(statusParam)) {
    query = query.eq('status', statusParam);
  }

  const { data, count, error } = await query;
  if (error) {
    return json({ ok: false, error: 'Не удалось получить обратную связь' }, 200);
  }

  const items = (data ?? []).map((r) => ({
    id: r.id as string,
    createdAt: r.created_at as string,
    source: (r.page_url as string | null) ?? null,
    message: r.message as string,
    who: r.user_id ? shortId(r.user_id as string) : 'аноним',
    status: r.status as string,
  }));

  return json({ ok: true, total: count ?? items.length, limit, offset, items });
}
