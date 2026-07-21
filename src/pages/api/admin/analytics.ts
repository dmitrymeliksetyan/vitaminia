import type { APIRoute } from 'astro';
import { checkAdminAccess, getAdminIds } from '../../../lib/admin/auth';
import { getRuntimeEnv } from '../../../lib/assistant/runtime-env';
import { getServiceRoleSupabase } from '../../../lib/server/service-role-supabase';
import { estimateAiCost } from '../../../lib/admin/ai-cost';
import { classifyUserStatus, shortId as sharedShortId } from '../../../lib/admin/user-status';
import { EVENT_LABELS as ALL_EVENT_LABELS } from '../../../lib/admin/event-labels';

// ЭТАП 1 аналитики — GET /api/admin/analytics?period=today|7d|30d|all
//
// Один запрос → сервер считает все агрегаты → один структурированный JSON
// (см. ТЗ часть 18 "Производительность"). НЕ возвращает: медицинские
// данные, тексты сообщений, содержимое Карты, email, имена, тексты
// feedback, полные профили — только числа и технические категории.
//
// Каждый показатель ниже сопровождён комментарием с точным определением
// (источник, что считается, уникальные vs количество действий, по какому
// created_at) — см. ТЗ часть 17 "точность статистики".

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Period = 'today' | '7d' | '30d' | 'all';

function getSince(period: Period): string | null {
  const now = new Date();
  if (period === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  if (period === '7d') return new Date(now.getTime() - 7 * 86_400_000).toISOString();
  if (period === '30d') return new Date(now.getTime() - 30 * 86_400_000).toISOString();
  return null; // 'all'
}

// Верхняя граница на сырую выборку для подсчёта distinct на прикладном
// уровне (см. countDistinct ниже) — защита от неограниченного роста запроса
// на зрелом проекте. Для объёма данных Этапа 1 с большим запасом достаточно;
// при реальном росте это первое место, которое стоит заменить на
// SQL-агрегацию (COUNT DISTINCT) через RPC, как уже сделано для retention.
const DISTINCT_FETCH_CAP = 50_000;

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    return await handleAnalytics(request, locals);
  } catch (err) {
    return json({ ok: false, error: 'Внутренняя ошибка', detail: String(err) }, 200);
  }
};

async function handleAnalytics(request: Request, locals: App.Locals): Promise<Response> {
  const access = await checkAdminAccess(request, locals);
  if (!access.ok) {
    return json({ ok: false, error: access.status === 401 ? 'Не авторизован' : 'Доступ запрещён' }, access.status);
  }

  const env = getRuntimeEnv(locals);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return json({ ok: false, error: 'Аналитика временно недоступна' }, 200);
  }
  const admin = getServiceRoleSupabase(serviceRoleKey);

  const url = new URL(request.url);
  const periodParam = (url.searchParams.get('period') ?? '30d') as Period;
  const period: Period = (['today', '7d', '30d', 'all'] as Period[]).includes(periodParam) ? periodParam : '30d';
  const since = getSince(period);

  // ── Правки Этапа 1 аналитики, п.6: исключение admin/test-аккаунтов ──
  // Единственное место, читающее ADMIN_USER_IDS (переиспользует парсинг из
  // src/lib/admin/auth.ts — той же переменной, что и для доступа к /admin).
  // Применяется централизованно внутри countDistinct/countRows ниже для
  // всех метрик, у которых есть прямая колонка user_id. НЕ применяется (и
  // не может быть применено без изменения SQL) к analytics_card_footprint()
  // и analytics_retention() — это RPC-функции (миграции 006/005), их правка
  // требует миграции БД, что явно выходит за рамки этих правок (см. финальный
  // отчёт, п.8). Также не применяется к assistant_messages (нет своей
  // колонки user_id — владение только через join к assistant_conversations).
  const adminIds = getAdminIds(locals);
  const adminIdList = adminIds.length > 0 ? `(${adminIds.join(',')})` : null;

  // ── distinct-хелпер: считает уникальные значения колонки среди строк,
  //    прошедших фильтр. Для показателей "количество уникальных
  //    пользователей/посетителей" — см. п.17 ТЗ ("COUNT DISTINCT user_id",
  //    а не голый COUNT(*)).
  async function countDistinct(table: string, column: string, eventName?: string): Promise<number> {
    let q = admin.from(table).select(column).limit(DISTINCT_FETCH_CAP);
    if (eventName) q = q.eq('event_name', eventName);
    q = q.not(column, 'is', null);
    if (since) q = q.gte('created_at', since);
    // Исключаем admin/test-аккаунты, только когда колонка — это реальный
    // user_id (никогда для anonymous_id — до входа в аккаунт связать
    // анонимного посетителя с admin-пользователем нечем и не нужно).
    if (column === 'user_id' && adminIdList) q = q.not('user_id', 'in', adminIdList);
    const { data } = await q;
    return new Set((data ?? []).map((r: Record<string, unknown>) => r[column])).size;
  }

  async function countRows(
    table: string,
    filter?: (q: ReturnType<typeof admin.from>) => ReturnType<typeof admin.from>,
    ownerColumn?: string,
  ): Promise<number> {
    let q = admin.from(table).select('id', { count: 'exact', head: true });
    if (filter) q = filter(q);
    if (since) q = q.gte('created_at', since);
    if (ownerColumn && adminIdList) q = q.not(ownerColumn, 'in', adminIdList);
    const { count } = await q;
    return count ?? 0;
  }

  // ============================================================
  // Основные показатели (ТЗ часть 10)
  // ============================================================

  // "Уникальные посетители" = COUNT DISTINCT COALESCE(user_id, anonymous_id)
  // среди ВСЕХ analytics_events за период (page_view — самое частое
  // событие и покрывает почти все визиты; используем все события, а не
  // только page_view, чтобы не терять визиты, начавшиеся с действия, а не
  // с загрузки значимой страницы).
  let visitorsQuery = admin.from('analytics_events').select('user_id, anonymous_id').limit(DISTINCT_FETCH_CAP);
  if (since) visitorsQuery = visitorsQuery.gte('created_at', since);
  const { data: visitorRows } = await visitorsQuery;
  const uniqueVisitors = new Set(
    (visitorRows ?? [])
      .filter((r) => !(r.user_id && adminIds.includes(r.user_id as string))) // исключаем admin (п.6)
      .map((r) => (r.user_id as string | null) ?? (r.anonymous_id as string | null))
      .filter(Boolean),
  ).size;

  // "Регистрации" = COUNT(*) FROM profiles WHERE is_primary=true, по
  // created_at профиля (Источник A — надёжнее события signup_completed,
  // т.к. профиль создаётся БД-триггером атомарно при регистрации).
  const signups = await countRows('profiles', (q) => q.eq('is_primary', true), 'user_id');

  // ── "Открыли Карту" / "Заполнили раздел" — ИСПРАВЛЕНО ──
  // Раньше считалось ТОЛЬКО по analytics_events (card_opened /
  // card_section_completed), из-за чего пользователи, работавшие с Картой
  // ДО подключения аналитики (миграция 005), показывали ложный ноль, даже
  // имея дневники/записи. См. отчёт о найденной логической ошибке.
  //
  // Теперь используется analytics_card_footprint() (миграция 006) —
  // объединяет analytics_events С фактическим наличием данных в profiles
  // (только реально отредактированные, не авто-созданные при регистрации),
  // emergency_info, health_entries, lifestyle, documents, а для широкого
  // варианта — ещё и observation_trackers/observation_records.
  //
  // Чистые числа "только по событиям" (без fallback) оставлены отдельно —
  // ниже, под cardOpenedUsersFromEventsOnly / cardSectionUsersFromEventsOnly
  // — специально для прозрачности между "событие" и "фактические данные"
  // (см. п.5 запроса на исправление).
  const cardOpenedUsersFromEventsOnly = await countDistinct('analytics_events', 'user_id', 'card_opened');
  const cardSectionUsersFromEventsOnly = await countDistinct('analytics_events', 'user_id', 'card_section_completed');

  // ИСПРАВЛЕНО (Этап 2, п.8): analytics_card_footprint теперь принимает
  // exclude_user_ids (миграция 007) — раньше эта RPC не исключала admin,
  // хотя все остальные метрики уже исключали (см. предыдущий этап правок).
  const { data: footprintRows } = await admin.rpc('analytics_card_footprint', { since, exclude_user_ids: adminIds });
  const footprint = footprintRows?.[0] ?? { users_with_card_data: 0, users_with_any_section: 0 };
  // "Открыли Карту" (итоговая цифра для карточек/воронок) = объединение
  // событий И фактических данных — см. комментарий выше.
  const cardOpenedUsers = Number(footprint.users_with_card_data);
  // "Заполнили хотя бы один раздел Карты" (итоговая цифра) — то же самое,
  // но без дневников (дневники — отдельный шаг воронки 3).
  const cardSectionCompletedUsers = Number(footprint.users_with_any_section);

  // "Открыли Помощника" = COUNT DISTINCT user_id с assistant_opened.
  const assistantOpenedUsers = await countDistinct('analytics_events', 'user_id', 'assistant_opened');

  // "Задали первый вопрос" = COUNT DISTINCT user_id с assistant_first_message.
  const assistantFirstMessageUsers = await countDistinct('analytics_events', 'user_id', 'assistant_first_message');

  // "Всего вопросов Помощнику" = Источник A: COUNT(*) FROM assistant_messages
  // WHERE role='user' (специально НЕ 'assistant' — считаем вопросы, не ответы).
  const assistantUserMessages = await countRows('assistant_messages', (q) => q.eq('role', 'user'));

  // "Создали дневник" = Источник A: COUNT DISTINCT user_id FROM
  // observation_trackers (надёжнее события journal_created).
  const journalsCreatedUsers = await countDistinct('observation_trackers', 'user_id');

  // "Добавили запись в дневник" = Источник A: COUNT DISTINCT user_id и
  // COUNT(*) FROM observation_records, по created_at записи (не measured_at
  // — measured_at может быть указан пользователем задним числом).
  const journalEntriesUsers = await countDistinct('observation_records', 'user_id');
  const journalEntriesTotal = await countRows('observation_records', undefined, 'user_id');

  // "Обратная связь" = Источник A: COUNT(*) FROM feedback_messages.
  // user_id здесь nullable (анонимная форма) — исключение admin работает
  // только для сообщений, где он был авторизован при отправке.
  const feedbackCount = await countRows('feedback_messages', undefined, 'user_id');

  // Дата первого события в analytics_events — когда реально включился
  // сбор Источника B. Используется в UI, чтобы подписать "по событиям, с
  // {дата}" честно, а не как будто аналитика работала всегда.
  const { data: firstEventRow } = await admin
    .from('analytics_events')
    .select('created_at')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const analyticsCollectingSince = firstEventRow?.created_at ?? null;

  // ============================================================
  // Воронки (ТЗ часть 11; методика пересмотрена — см. "Правки Этапа 1
  // аналитики", п.1)
  // ============================================================
  // ВАЖНО: это НЕ строгая когортная воронка одних и тех же людей — это
  // срез количества уникальных идентификаторов, достигших каждого шага В
  // ПРЕДЕЛАХ ПЕРИОДА. Например, шаг 2 воронки 1 считает всех, кто начал
  // регистрацию в периоде — не обязательно тех же людей, что "посетили
  // сайт" в начале того же периода (кто-то мог посетить раньше периода, а
  // зарегистрироваться уже в периоде). Для Этапа 1 это сознательное
  // упрощение (см. ТЗ часть 14: "не строить сложную cohort-систему") —
  // строгая когортная связка по anonymous_id/user_id — материал для Этапа 2.
  //
  // ИСПРАВЛЕНО: раньше воронка 1 продолжалась шагами "Открыли Карту" /
  // "Сохранили раздел", которые считаются СОВСЕМ другим способом — через
  // analytics_card_footprint() (объединяет события И исторические данные
  // из profiles/health_entries/... по user_id, без ограничения по дате
  // начала событий). Из-за этого визуально одна "последовательная" воронка
  // склеивала два разных измерения и могла показывать 5 → 0 → 0 → 2 → 2 —
  // числа расти не может, если это правда одна когорта. Это не баг в
  // расчёте отдельных чисел (каждое само по себе верно), а некорректная
  // подача НЕСОПОСТАВИМЫХ шагов как одной когортной последовательности.
  //
  // Решение (минимальное, без переделки интерфейса): воронка 1 теперь
  // содержит только 3 шага, все — из одного источника (analytics_events,
  // по anonymous_id, один и тот же период) — честная и логически
  // непротиворечивая последовательность анонимного привлечения. Шаги
  // "Открыли Карту" / "Сохранили раздел" никуда не делись — они остались
  // в "Основных показателях" и как первый шаг воронки 3 (там методика
  // ОДНОРОДНА по всем шагам — см. ниже), просто больше не выглядят частью
  // одной когорты с анонимными посетителями.
  const signupStartedVisitors = await countDistinct('analytics_events', 'anonymous_id', 'signup_started');
  const signupCompletedVisitors = await countDistinct('analytics_events', 'anonymous_id', 'signup_completed');
  // "Посетили сайт" для ЭТОЙ воронки — намеренно anonymous_id (не user_id
  // ИЛИ anonymous_id, как в карточке "Уникальные посетители" выше) — это
  // воронка привлечения ДО входа в аккаунт, и signup_started/completed
  // тоже пишутся по anonymous_id. Один и тот же идентификатор на всех
  // трёх шагах — это и делает шаги сопоставимыми.
  const uniqueAnonymousVisitors = await countDistinct('analytics_events', 'anonymous_id');

  const funnel1 = [
    { step: 'Посетили сайт (аноним.)', count: uniqueAnonymousVisitors },
    { step: 'Начали регистрацию', count: signupStartedVisitors },
    { step: 'Завершили регистрацию', count: signupCompletedVisitors },
  ];

  const funnel2 = [
    { step: 'Зарегистрировались', count: signups },
    { step: 'Открыли Помощника', count: assistantOpenedUsers },
    { step: 'Задали первый вопрос', count: assistantFirstMessageUsers },
  ];

  // Воронка 3 полностью реализуема через Источник A — profile→карта уже
  // проверена архитектурно: observation_trackers/observation_records
  // содержат user_id напрямую, конфликтов с текущей схемой не найдено.
  // Все 3 шага здесь однородны по методике (footprint/фактические данные
  // по user_id, с историческим fallback) — в отличие от бывшей воронки 1,
  // здесь это не создаёт нелогичного скачка, потому что ни один из шагов
  // не смешан с чистой событийной анонимной статистикой.
  const funnel3 = [
    { step: 'Использовали Карту', count: cardOpenedUsers },
    { step: 'Создали дневник', count: journalsCreatedUsers },
    { step: 'Добавили первую запись', count: journalEntriesUsers },
  ];

  function withPercentages(steps: Array<{ step: string; count: number }>) {
    return steps.map((s, i) => ({
      ...s,
      percentOfPrevious:
        i === 0 ? null : steps[i - 1].count > 0 ? Math.round((s.count / steps[i - 1].count) * 1000) / 10 : 0,
    }));
  }

  // ============================================================
  // Активность по дням (ТЗ часть 12) — последние 30 дней, независимо от
  // выбранного периода (график всегда показывает фиксированное окно).
  // ============================================================
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: dailyEventRows } = await admin
    .from('analytics_events')
    .select('user_id, anonymous_id, created_at')
    .gte('created_at', thirtyDaysAgo)
    .limit(DISTINCT_FETCH_CAP);
  let dailySignupQuery = admin
    .from('profiles')
    .select('created_at')
    .eq('is_primary', true)
    .gte('created_at', thirtyDaysAgo)
    .limit(DISTINCT_FETCH_CAP);
  if (adminIdList) dailySignupQuery = dailySignupQuery.not('user_id', 'in', adminIdList);
  const { data: dailySignupRows } = await dailySignupQuery;

  const dayBuckets = new Map<string, { activeUsers: Set<string>; signups: number }>();
  for (const row of dailyEventRows ?? []) {
    if (row.user_id && adminIds.includes(row.user_id as string)) continue; // исключаем admin (п.6)
    const day = (row.created_at as string).slice(0, 10);
    const id = (row.user_id as string | null) ?? (row.anonymous_id as string | null);
    if (!id) continue;
    if (!dayBuckets.has(day)) dayBuckets.set(day, { activeUsers: new Set(), signups: 0 });
    dayBuckets.get(day)!.activeUsers.add(id);
  }
  for (const row of dailySignupRows ?? []) {
    const day = (row.created_at as string).slice(0, 10);
    if (!dayBuckets.has(day)) dayBuckets.set(day, { activeUsers: new Set(), signups: 0 });
    dayBuckets.get(day)!.signups += 1;
  }
  const dailyActivity = [...dayBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, activeUsers: v.activeUsers.size, signups: v.signups }));

  // ============================================================
  // Последние события (ТЗ часть 13; уточнено правками Этапа 1, п.4) —
  // без имён/email/содержимого. ИСПРАВЛЕНО: раньше несколько одинаковых
  // событий подряд ("Открыта Карта / Открыта Карта / Открыта Карта")
  // нельзя было отличить друг от друга — не было понятно, один это
  // человек или разные. Теперь к каждому событию добавляется короткий
  // анонимизированный "хвост" идентификатора (последние 4 символа
  // user_id/anonymous_id) — этого достаточно, чтобы отличать записи друг
  // от друга, но недостаточно, чтобы деанонимизировать пользователя.
  // page_view сознательно НЕ включён в этот список — это самое частое
  // событие на сайте (см. комментарий про uniqueVisitors выше), и его
  // включение просто вытеснило бы из "последних 10" всё остальное шумом.
  // ============================================================
  // Тексты названий событий — из общего src/lib/admin/event-labels.ts
  // (переиспользуется также в /api/admin/users/[id], чтобы не завести два
  // независимых списка названий). Но НАБОР событий, попадающих в ЭТУ ленту
  // ("последние 10" по всем пользователям), сознательно ýже, чем полный
  // список — это curated-подборка ключевых действий, а не полная история;
  // полная история по конкретному пользователю — в карточке /admin/users/[id].
  const EVENT_LABELS: Record<string, string> = {
    signup_completed: ALL_EVENT_LABELS.signup_completed,
    card_opened: ALL_EVENT_LABELS.card_opened,
    assistant_first_message: ALL_EVENT_LABELS.assistant_first_message,
    journal_created: ALL_EVENT_LABELS.journal_created,
  };
  function shortId(id: string | null | undefined): string | null {
    return id ? sharedShortId(id) : null;
  }
  function describeWho(userId: string | null, anonymousId: string | null): string | null {
    if (userId) return `пользователь ${shortId(userId)}`;
    if (anonymousId) return `анонимный посетитель ${shortId(anonymousId)}`;
    return null;
  }
  let recentEventsQuery = admin
    .from('analytics_events')
    .select('event_name, created_at, user_id, anonymous_id')
    .in('event_name', Object.keys(EVENT_LABELS))
    .order('created_at', { ascending: false })
    .limit(10);
  if (adminIdList) recentEventsQuery = recentEventsQuery.not('user_id', 'in', adminIdList);
  const { data: recentEventRows } = await recentEventsQuery;

  let recentFeedbackQuery = admin
    .from('feedback_messages')
    .select('created_at, user_id')
    .order('created_at', { ascending: false })
    .limit(5);
  if (adminIdList) recentFeedbackQuery = recentFeedbackQuery.not('user_id', 'in', adminIdList);
  const { data: recentFeedbackRows } = await recentFeedbackQuery;

  const recentActivity = [
    ...(recentEventRows ?? []).map((r) => {
      const base = EVENT_LABELS[r.event_name as string] ?? (r.event_name as string);
      const who = describeWho(r.user_id as string | null, r.anonymous_id as string | null);
      return { label: who ? `${base} · ${who}` : base, at: r.created_at as string };
    }),
    ...(recentFeedbackRows ?? []).map((r) => ({ label: 'Получена обратная связь', at: r.created_at as string })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 10);

  // ============================================================
  // Retention D1/D7/D30 (Этап 2, п.7) — analytics_retention() (миграция
  // 007) теперь: (а) исключает admin/test через exclude_user_ids, (б)
  // считает "вернулся в D-N" по календарным суткам (строго N-й день после
  // регистрации), что и чинит старый баг с D1 (раньше окно "+1 day..+1 day"
  // было нулевой ширины и всегда давало 0 — см. финальный отчёт).
  //
  // Для каждого окна когорта берётся так, чтобы её D-N уже гарантированно
  // наступил (иначе "0% вернулось" будет означать "ещё рано", а не
  // реальный отток) — регистрация минимум за (N+1) день до "сейчас".
  // ============================================================
  const now = new Date();
  const cohort1 = await admin.rpc('analytics_retention', {
    cohort_start: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    cohort_end: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    window_days: 1,
    exclude_user_ids: adminIds,
  });
  const cohort7 = await admin.rpc('analytics_retention', {
    cohort_start: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    cohort_end: new Date(now.getTime() - 8 * 86_400_000).toISOString(),
    window_days: 7,
    exclude_user_ids: adminIds,
  });
  const cohort30 = await admin.rpc('analytics_retention', {
    cohort_start: new Date(now.getTime() - 90 * 86_400_000).toISOString(),
    cohort_end: new Date(now.getTime() - 31 * 86_400_000).toISOString(),
    window_days: 30,
    exclude_user_ids: adminIds,
  });
  const retention1 = cohort1.data?.[0] ?? { cohort_size: 0, retained_count: 0 };
  const retention7 = cohort7.data?.[0] ?? { cohort_size: 0, retained_count: 0 };
  const retention30 = cohort30.data?.[0] ?? { cohort_size: 0, retained_count: 0 };

  // ============================================================
  // Сегменты пользователей (Этап 2, п.9) — компактный блок на /admin,
  // ведущий в /admin/users?status=... . СЧИТАЕТСЯ ТЕМ ЖЕ RPC и ТОЙ ЖЕ
  // функцией classifyUserStatus, что и сам список /api/admin/users —
  // единый источник истины, см. src/lib/admin/user-status.ts.
  // ============================================================
  const { data: segmentFootprintRows } = await admin.rpc('analytics_user_footprint', {
    exclude_user_ids: adminIds,
  });
  const nowForStatus = new Date();
  const userSegments = { new: 0, active: 0, returning: 0, inactive: 0 };
  for (const row of segmentFootprintRows ?? []) {
    const status = classifyUserStatus(
      nowForStatus,
      new Date(row.registered_at as string),
      new Date(row.last_active_at as string),
      Number(row.active_days_count),
    );
    userSegments[status] += 1;
  }

  // ============================================================
  // AI-расходы (ТЗ часть 15) — из metadata.ai_usage в assistant_messages,
  // которую уже сохраняет /api/assistant/chat из реального ответа Anthropic
  // (usage), без единого дополнительного AI-вызова.
  // ============================================================
  let aiQuery = admin
    .from('assistant_messages')
    .select('metadata')
    .eq('role', 'assistant')
    .not('metadata->ai_usage', 'is', null)
    .limit(DISTINCT_FETCH_CAP);
  if (since) aiQuery = aiQuery.gte('created_at', since);
  const { data: aiRows } = await aiQuery;

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let aiRequestCount = 0;
  const costByModel = new Map<string, { input: number; output: number }>();
  for (const row of aiRows ?? []) {
    const usage = (row.metadata as { ai_usage?: { input_tokens: number; output_tokens: number; model: string } })
      ?.ai_usage;
    if (!usage) continue;
    aiRequestCount += 1;
    totalInputTokens += usage.input_tokens ?? 0;
    totalOutputTokens += usage.output_tokens ?? 0;
    const bucket = costByModel.get(usage.model) ?? { input: 0, output: 0 };
    bucket.input += usage.input_tokens ?? 0;
    bucket.output += usage.output_tokens ?? 0;
    costByModel.set(usage.model, bucket);
  }
  const costBreakdown = [...costByModel.entries()].map(([model, t]) => estimateAiCost(model, t.input, t.output));
  // ИСПРАВЛЕНО (Правки Этапа 1 аналитики, п.2): при aiRequestCount === 0
  // costBreakdown — пустой массив, и Array.prototype.every на пустом
  // массиве возвращает true (ванильная истина), из-за чего раньше
  // получался totalCostUsd = 0 — то есть интерфейс показывал "$0.0000",
  // как будто известно, что стоимость нулевая. На самом деле это значит
  // "нет ни одного запроса с сохранённой информацией о токенах" — данных
  // о стоимости просто нет, и это должно отображаться как "нет данных",
  // а не как "стоимость равна нулю". Различие принципиальное (см. ТЗ).
  const totalCostUsd =
    aiRequestCount === 0
      ? null
      : costBreakdown.every((c) => c.estimatedCostUsd !== null)
        ? Math.round(costBreakdown.reduce((sum, c) => sum + (c.estimatedCostUsd ?? 0), 0) * 10000) / 10000
        : null;

  return json({
    ok: true,
    period,
    analyticsCollectingSince,
    metrics: {
      uniqueVisitors,
      signups,
      cardOpenedUsers,
      cardOpenedUsersFromEventsOnly,
      cardSectionCompletedUsers,
      cardSectionUsersFromEventsOnly,
      assistantOpenedUsers,
      assistantFirstMessageUsers,
      assistantUserMessages,
      journalsCreatedUsers,
      journalEntriesUsers,
      journalEntriesTotal,
      feedbackCount,
    },
    funnels: {
      funnel1: withPercentages(funnel1),
      funnel2: withPercentages(funnel2),
      funnel3: withPercentages(funnel3),
    },
    dailyActivity,
    recentActivity,
    userSegments,
    retention: {
      days1: {
        cohortSize: Number(retention1.cohort_size),
        retainedCount: Number(retention1.retained_count),
        percent:
          Number(retention1.cohort_size) > 0
            ? Math.round((Number(retention1.retained_count) / Number(retention1.cohort_size)) * 1000) / 10
            : null,
      },
      days7: {
        cohortSize: Number(retention7.cohort_size),
        retainedCount: Number(retention7.retained_count),
        percent:
          Number(retention7.cohort_size) > 0
            ? Math.round((Number(retention7.retained_count) / Number(retention7.cohort_size)) * 1000) / 10
            : null,
      },
      days30: {
        cohortSize: Number(retention30.cohort_size),
        retainedCount: Number(retention30.retained_count),
        percent:
          Number(retention30.cohort_size) > 0
            ? Math.round((Number(retention30.retained_count) / Number(retention30.cohort_size)) * 1000) / 10
            : null,
      },
    },
    ai: {
      // "Всего вопросов" (metrics.assistantUserMessages, включая исторические
      // сообщения без token-метаданных) и "requestCount" (только сообщения,
      // для которых реально сохранена metadata.ai_usage) — сознательно два
      // разных числа, см. п.2 правок. inputTokens/outputTokens/estimatedCostUsd
      // — null, если requestCount === 0, то есть данных о токенах вообще нет
      // (а не "0 токенов потрачено").
      requestCount: aiRequestCount,
      inputTokens: aiRequestCount === 0 ? null : totalInputTokens,
      outputTokens: aiRequestCount === 0 ? null : totalOutputTokens,
      estimatedCostUsd: totalCostUsd,
      byModel: costBreakdown,
    },
  });
}
