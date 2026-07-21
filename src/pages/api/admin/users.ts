import type { APIRoute } from 'astro';
import { checkAdminAccess, getAdminIds } from '../../../lib/admin/auth';
import { getRuntimeEnv } from '../../../lib/assistant/runtime-env';
import { getServiceRoleSupabase } from '../../../lib/server/service-role-supabase';
import { classifyUserStatus, shortId, type UserStatus } from '../../../lib/admin/user-status';

// Аналитика и админка, Этап 2 — GET /api/admin/users?status=&usedCard=&
// usedAssistant=&hasJournal=&search=&limit=&offset=
//
// Источник данных — ОДНА RPC-функция analytics_user_footprint() (миграция
// 007), которая уже исключает ADMIN_USER_IDS и не возвращает НИ ОДНОГО
// медицинского поля — только user_id, даты и счётчики. Фильтры/поиск/
// пагинация применяются здесь, поверх этого компактного набора (не сырых
// медицинских таблиц) — см. итоговый отчёт, п.4/п.5.
//
// ВАЖНО (п.10 ТЗ): "если интерфейс не показывает поле — не значит, что его
// можно прислать в JSON". Ниже explicit allow-list полей в ответе — принцип
// тот же, что и в /api/admin/content/registry.

export const prerender = false;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const FOOTPRINT_CAP = 2000; // защитный предел строк из RPC — см. DISTINCT_FETCH_CAP в analytics.ts

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FootprintRow {
  user_id: string;
  registered_at: string;
  last_active_at: string;
  active_days_count: number;
  used_card: boolean;
  card_sections_count: number;
  used_assistant: boolean;
  assistant_messages_count: number;
  journals_count: number;
  journal_entries_count: number;
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    return await handleUsers(request, locals);
  } catch (err) {
    return json({ ok: false, error: 'Внутренняя ошибка', detail: String(err) }, 200);
  }
};

async function handleUsers(request: Request, locals: App.Locals): Promise<Response> {
  const access = await checkAdminAccess(request, locals);
  if (!access.ok) {
    return json({ ok: false, error: access.status === 401 ? 'Не авторизован' : 'Доступ запрещён' }, access.status);
  }

  const env = getRuntimeEnv(locals);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return json({ ok: false, error: 'Список пользователей временно недоступен' }, 200);
  }
  const admin = getServiceRoleSupabase(serviceRoleKey);
  const adminIds = getAdminIds(locals);

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status') as UserStatus | 'all' | null;
  const usedCardFilter = url.searchParams.get('usedCard'); // 'true' | null
  const usedAssistantFilter = url.searchParams.get('usedAssistant');
  const hasJournalFilter = url.searchParams.get('hasJournal');
  const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  const { data: rows, error } = await admin
    .rpc('analytics_user_footprint', { exclude_user_ids: adminIds })
    .limit(FOOTPRINT_CAP);
  if (error) {
    return json({ ok: false, error: 'Не удалось получить список пользователей' }, 200);
  }

  const now = new Date();
  let items = ((rows ?? []) as FootprintRow[]).map((r) => {
    const status = classifyUserStatus(now, new Date(r.registered_at), new Date(r.last_active_at), Number(r.active_days_count));
    return {
      id: r.user_id, // полный UUID — используется ТОЛЬКО для ссылки /admin/users/[id], в таблице показывается shortId
      shortId: shortId(r.user_id),
      registeredAt: r.registered_at,
      lastActiveAt: r.last_active_at,
      activeDaysCount: Number(r.active_days_count),
      usedCard: r.used_card,
      cardSectionsCount: Number(r.card_sections_count),
      usedAssistant: r.used_assistant,
      assistantMessagesCount: Number(r.assistant_messages_count),
      journalsCount: Number(r.journals_count),
      journalEntriesCount: Number(r.journal_entries_count),
      status,
    };
  });

  // Поиск — ТОЛЬКО по полному или короткому user ID (см. п.4 ТЗ: не по
  // имени/email/медицинским данным, которых в этом наборе и так нет).
  if (search) {
    items = items.filter((u) => u.id.toLowerCase().includes(search) || u.shortId.toLowerCase().includes(search));
  }
  if (statusFilter && statusFilter !== 'all') {
    items = items.filter((u) => u.status === statusFilter);
  }
  if (usedCardFilter === 'true') items = items.filter((u) => u.usedCard);
  if (usedAssistantFilter === 'true') items = items.filter((u) => u.usedAssistant);
  if (hasJournalFilter === 'true') items = items.filter((u) => u.journalsCount > 0);

  items.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());

  const total = items.length;
  const page = items.slice(offset, offset + limit);

  return json({
    ok: true,
    total,
    limit,
    offset,
    items: page,
  });
}
