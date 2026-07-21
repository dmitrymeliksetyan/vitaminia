import type { APIRoute } from 'astro';
import { checkAdminAccess, getAdminIds } from '../../../../lib/admin/auth';
import { getRuntimeEnv } from '../../../../lib/assistant/runtime-env';
import { getServiceRoleSupabase } from '../../../../lib/server/service-role-supabase';
import { classifyUserStatus, shortId } from '../../../../lib/admin/user-status';
import { EVENT_LABELS } from '../../../../lib/admin/event-labels';

// Аналитика и админка, Этап 2 — GET /api/admin/users/[id]
//
// Карточка ИСПОЛЬЗОВАНИЯ ПРОДУКТА, не медицинская карта (см. п.5 ТЗ).
// Возвращает: короткий ID, даты, статус, счётчики (из analytics_user_footprint,
// та же RPC, что и список) + ленту продуктовых СОБЫТИЙ ПО ТИПУ (название +
// дата), БЕЗ metadata события (там могло бы быть, например, название раздела
// Карты — сознательно не選ём, не отдаём). Никогда не читает content/text
// полей assistant_messages, health_entries.data, observation_records.*,
// documents.* и т.п.

export const prerender = false;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMELINE_LIMIT = 40;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ request, locals, params }) => {
  try {
    return await handleUserDetail(request, locals, params.id ?? '');
  } catch (err) {
    return json({ ok: false, error: 'Внутренняя ошибка', detail: String(err) }, 200);
  }
};

async function handleUserDetail(request: Request, locals: App.Locals, id: string): Promise<Response> {
  const access = await checkAdminAccess(request, locals);
  if (!access.ok) {
    return json({ ok: false, error: access.status === 401 ? 'Не авторизован' : 'Доступ запрещён' }, access.status);
  }

  if (!UUID_PATTERN.test(id)) {
    return json({ ok: false, error: 'Некорректный идентификатор пользователя' }, 200);
  }

  const env = getRuntimeEnv(locals);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return json({ ok: false, error: 'Карточка пользователя временно недоступна' }, 200);
  }
  const admin = getServiceRoleSupabase(serviceRoleKey);
  const adminIds = getAdminIds(locals);

  // target_user_id сужает RPC до одной строки. Если id совпадает с
  // ADMIN_USER_IDS, exclude_user_ids отфильтрует её же — вернётся пусто,
  // то есть посмотреть карточку самого админа через этот путь нельзя.
  const { data: rows, error } = await admin.rpc('analytics_user_footprint', {
    exclude_user_ids: adminIds,
    target_user_id: id,
  });
  if (error) {
    return json({ ok: false, error: 'Не удалось получить данные пользователя' }, 200);
  }
  const row = rows?.[0];
  if (!row) {
    return json({ ok: false, error: 'Пользователь не найден' }, 200);
  }

  const now = new Date();
  const status = classifyUserStatus(now, new Date(row.registered_at), new Date(row.last_active_at), Number(row.active_days_count));

  // Лента событий — ТОЛЬКО event_name + created_at, без metadata (там могло
  // бы быть, например, название раздела Карты — см. ограничения п.5 ТЗ).
  const { data: eventRows } = await admin
    .from('analytics_events')
    .select('event_name, created_at')
    .eq('user_id', id)
    .in('event_name', Object.keys(EVENT_LABELS))
    .order('created_at', { ascending: false })
    .limit(TIMELINE_LIMIT);

  const timeline = [
    { label: 'Зарегистрировался', at: row.registered_at as string },
    ...((eventRows ?? []) as Array<{ event_name: string; created_at: string }>).map((r) => ({
      label: EVENT_LABELS[r.event_name] ?? r.event_name,
      at: r.created_at,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return json({
    ok: true,
    user: {
      id: row.user_id,
      shortId: shortId(row.user_id as string),
      registeredAt: row.registered_at,
      lastActiveAt: row.last_active_at,
      activeDaysCount: Number(row.active_days_count),
      status,
      usedCard: row.used_card,
      cardSectionsCount: Number(row.card_sections_count),
      usedAssistant: row.used_assistant,
      assistantMessagesCount: Number(row.assistant_messages_count),
      journalsCount: Number(row.journals_count),
      journalEntriesCount: Number(row.journal_entries_count),
    },
    timeline,
  });
}
