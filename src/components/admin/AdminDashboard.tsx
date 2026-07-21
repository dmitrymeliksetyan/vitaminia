import React, { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { supabase } from '../../lib/auth/browser-supabase';
import AdminNav from './AdminNav';
import { RefreshingHint, RetryBanner } from './dashboard-shared';
import { hasRecentAdminOk, markAdminOk, clearAdminSessionCache, getCachedData, setCachedData } from '../../lib/admin/client-session-cache';

// ЭТАП 1 аналитики — /admin. Вся авторизация проверяется СЕРВЕРОМ на
// каждый запрос к /api/admin/analytics (см. src/lib/admin/auth.ts) — этот
// компонент просто отражает то, что вернул сервер (401/403/200), сам
// список статистики никогда не читает из Supabase напрямую.
//
// ТЗ "Убрать повторную проверку доступа и Load failed" — см.
// src/lib/admin/client-session-cache.ts для полного объяснения причины
// (каждый раздел админки — отдельная Astro-страница, переходы — полная
// перезагрузка). Здесь: если доступ подтверждён недавно и есть кэш ответа
// за этот period — рендерим сразу (phase='ready' с самого начала, без
// полноэкранного "Проверка доступа…"), а свежие данные подгружаем в фоне.

type Period = 'today' | '7d' | '30d' | 'all';
// 'loading' vs 'checking' — ТЗ жалуется буквально на повторную надпись
// "Проверка доступа…" при обычных переходах. Разделяем два разных смысла,
// которые раньше были одним и тем же экраном: 'checking' — доступ ещё
// НИКОГДА не подтверждался в этой сессии (см. hasRecentAdminOk); 'loading'
// — доступ уже подтверждён недавно (например, вы только что были на другой
// странице админки), просто для ЭТОГО конкретного представления (period)
// ещё нет закэшированных данных — тогда честно показываем нейтральную
// "Загрузка…", а не пугающую "Проверка доступа…".
type Phase = 'checking' | 'loading' | 'unauthorized' | 'forbidden' | 'ready' | 'error';

interface AnalyticsResponse {
  ok: true;
  period: Period;
  analyticsCollectingSince: string | null;
  metrics: {
    uniqueVisitors: number;
    signups: number;
    cardOpenedUsers: number;
    cardOpenedUsersFromEventsOnly: number;
    cardSectionCompletedUsers: number;
    cardSectionUsersFromEventsOnly: number;
    assistantOpenedUsers: number;
    assistantFirstMessageUsers: number;
    assistantUserMessages: number;
    journalsCreatedUsers: number;
    journalEntriesUsers: number;
    journalEntriesTotal: number;
    feedbackCount: number;
  };
  funnels: {
    funnel1: Array<{ step: string; count: number; percentOfPrevious: number | null }>;
    funnel2: Array<{ step: string; count: number; percentOfPrevious: number | null }>;
    funnel3: Array<{ step: string; count: number; percentOfPrevious: number | null }>;
  };
  dailyActivity: Array<{ day: string; activeUsers: number; signups: number }>;
  recentActivity: Array<{ label: string; at: string }>;
  // Этап 2, п.9 — компактный блок сегментов на /admin, ведущий в
  // /admin/users?status=... . Тот же источник (analytics_user_footprint +
  // classifyUserStatus), что и сам список пользователей.
  userSegments: { new: number; active: number; returning: number; inactive: number };
  retention: {
    days1: { cohortSize: number; retainedCount: number; percent: number | null };
    days7: { cohortSize: number; retainedCount: number; percent: number | null };
    days30: { cohortSize: number; retainedCount: number; percent: number | null };
  };
  ai: {
    requestCount: number;
    // null = данных о токенах нет вообще (а не "0 токенов потрачено") — см.
    // Правки Этапа 1 аналитики, п.2.
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUsd: number | null;
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number | null }>;
  };
}

const PERIOD_OPTIONS: Array<{ key: Period; label: string }> = [
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: 'all', label: 'Всё время' },
];

function formatDate(iso: string | null): string {
  if (!iso) return 'событий пока нет';
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function AdminDashboard() {
  const [period, setPeriod] = useState<Period>('30d');
  const cacheKey = `analytics:${period}`;
  const [phase, setPhase] = useState<Phase>(() => {
    if (getCachedData<AnalyticsResponse>(cacheKey)) return 'ready';
    return hasRecentAdminOk() ? 'loading' : 'checking';
  });
  const [data, setData] = useState<AnalyticsResponse | null>(() => getCachedData<AnalyticsResponse>(cacheKey));
  const [errorMessage, setErrorMessage] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedData<AnalyticsResponse>(cacheKey);
    if (cached) {
      // Есть свежий (в рамках TTL) подтверждённый доступ и кэш ровно под
      // этот period — показываем его сразу вместо блокирующего "Проверка
      // доступа…", а актуализируем в фоне (см. client-session-cache.ts).
      setData(cached);
      setPhase('ready');
      setRefreshing(true);
    } else {
      setPhase(hasRecentAdminOk() ? 'loading' : 'checking');
    }

    async function load() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;

      if (!session) {
        clearAdminSessionCache();
        setPhase('unauthorized');
        return;
      }

      try {
        const res = await fetch(`/api/admin/analytics?period=${period}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (cancelled) return;

        if (res.status === 401) {
          clearAdminSessionCache();
          setPhase('unauthorized');
          return;
        }
        if (res.status === 403) {
          clearAdminSessionCache();
          setPhase('forbidden');
          return;
        }

        const json = (await res.json()) as AnalyticsResponse | { ok: false; error: string };
        if (!json.ok) {
          console.warn('[admin/analytics] сервер вернул ok:false —', json.error);
          if (cached) setLoadError(json.error);
          else {
            setErrorMessage(json.error);
            setPhase('error');
          }
          return;
        }
        markAdminOk();
        setCachedData(cacheKey, json);
        setData(json);
        setPhase('ready');
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Не удалось загрузить статистику';
        // Диагностика без раскрытия секретов — видно, какой именно запрос
        // упал и с какой причиной (в т.ч. "Load failed"), не скрываем это
        // общей фразой в консоли, даже если на экране остаётся баннер.
        console.warn('[admin/analytics] fetch завершился ошибкой:', err);
        if (cached) {
          setLoadError(msg);
        } else {
          setErrorMessage(msg);
          setPhase('error');
        }
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [period, reloadTick]);

  if (phase === 'checking') {
    return <Centered>Проверка доступа…</Centered>;
  }
  if (phase === 'loading') {
    return <Centered>Загрузка…</Centered>;
  }
  if (phase === 'unauthorized') {
    return (
      <Centered>
        Нужно войти в аккаунт.{' '}
        <a href="/auth/login" style={{ color: 'var(--color-brand-blue)' }}>
          Войти
        </a>
      </Centered>
    );
  }
  if (phase === 'forbidden') {
    return <Centered>Доступ к этой странице ограничен.</Centered>;
  }
  if (phase === 'error') {
    return <Centered>Не удалось загрузить статистику: {errorMessage}</Centered>;
  }
  if (!data) return null;

  return (
    <div style={{ maxWidth: 'var(--container-wide)', margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}>
      <AdminNav current="analytics" />
      <RefreshingHint show={refreshing} />
      {loadError && <RetryBanner message={loadError} onRetry={() => setReloadTick((t) => t + 1)} />}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-5)', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-semibold)', margin: 0, color: 'var(--color-text)' }}>
          Аналитика
        </h1>
        <div style={{ display: 'flex', gap: 4, background: 'var(--color-neutral-100)', padding: 4, borderRadius: 'var(--radius-md)' }}>
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setPeriod(opt.key)}
              style={{
                fontSize: 'var(--font-size-sm)',
                padding: '6px 14px',
                borderRadius: 'var(--radius-md)',
                border: 'none',
                background: period === opt.key ? '#fff' : 'transparent',
                color: period === opt.key ? 'var(--color-brand-blue)' : 'var(--color-text-secondary)',
                fontWeight: period === opt.key ? 'var(--font-weight-medium)' : 'var(--font-weight-regular)',
                cursor: 'pointer',
                boxShadow: period === opt.key ? 'var(--shadow-sm)' : 'none',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-text-secondary)',
        background: 'var(--color-bg-info)',
        border: '1px solid var(--color-border-info)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3) var(--space-4)',
        marginBottom: 'var(--space-6)',
      }}>
        Сбор событий (посещения, открытия разделов и т.д.) включён {formatDate(data.analyticsCollectingSince)}.
        Показатели, отмеченные как «есть данные», дополнительно учитывают фактическое содержимое Карты и
        дневников — так пользователи, работавшие с сайтом до включения аналитики, не выглядят нулями.
      </div>

      <SectionTitle>Основные показатели</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-8)' }}>
        <MetricCard label="Уникальные посетители" value={data.metrics.uniqueVisitors} hint="user_id или anonymous_id, встретившийся хотя бы в одном событии за период" />
        <MetricCard label="Регистрации" value={data.metrics.signups} hint="новые профили за период" />
        <MetricCard
          label="Использовали Карту"
          value={data.metrics.cardOpenedUsers}
          hint={`Уникальные пользователи: событие "открыл Карту" ИЛИ фактически есть данные в Карте/дневниках (профиль, экстренная информация, записи, образ жизни, документы, дневники). Только по событиям (доступно с ${formatDate(data.analyticsCollectingSince)}): ${data.metrics.cardOpenedUsersFromEventsOnly}.`}
        />
        <MetricCard
          label="Заполнили раздел Карты"
          value={data.metrics.cardSectionCompletedUsers}
          hint={`Уникальные пользователи с хотя бы одним разделом Карты (профиль/экстренная информация/записи/образ жизни/документы), по фактическим данным ИЛИ по событию сохранения. Только по событиям: ${data.metrics.cardSectionUsersFromEventsOnly}.`}
        />
        <MetricCard label="Открыли Помощника" value={data.metrics.assistantOpenedUsers} hint="уникальные пользователи" />
        <MetricCard
          label="Задали первый вопрос"
          value={data.metrics.assistantFirstMessageUsers}
          hint={`уникальные пользователи по событию, доступно только с ${formatDate(data.analyticsCollectingSince)} — вопросы, заданные раньше, сюда не попадают`}
        />
        <MetricCard label="Всего вопросов Помощнику" value={data.metrics.assistantUserMessages} hint="сообщения пользователя, не ответы AI, включая историю до включения аналитики" />
        <MetricCard label="Создали дневник" value={data.metrics.journalsCreatedUsers} hint="уникальные пользователи" />
        <MetricCard
          label="Записи в дневниках"
          value={
            <span style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span>{data.metrics.journalEntriesUsers} пользователя</span>
              <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-regular)' }}>
                {data.metrics.journalEntriesTotal} записей
              </span>
            </span>
          }
          hint="уникальные пользователи и общее число записей"
        />
        <MetricCard label="Обратная связь" value={data.metrics.feedbackCount} hint="новые сообщения за период" />
      </div>

      <SectionTitle>Воронки</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-8)' }}>
        <FunnelCard
          title="Посетитель → Регистрация"
          steps={data.funnels.funnel1}
          note={`Анонимные посетители, по событиям с ${formatDate(data.analyticsCollectingSince)} — до входа в аккаунт.`}
        />
        <FunnelCard title="Регистрация → Помощник" steps={data.funnels.funnel2} />
        <FunnelCard title="Карта → Дневники" steps={data.funnels.funnel3} />
      </div>

      <SectionTitle>Активность за 30 дней</SectionTitle>
      <div style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)', marginBottom: 'var(--space-8)', height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.dailyActivity}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 'var(--font-size-xs)' }} />
            {/* type="linear" — обычные прямые отрезки между дневными точками, без
                сглаживания monotone, которое создавало впечатление непрерывного
                изменения между несколькими реальными точками (см. правки, п.3). */}
            <Line type="linear" dataKey="activeUsers" name="Активные пользователи" stroke="#1e3a7b" strokeWidth={2} dot={{ r: 2 }} />
            <Line type="linear" dataKey="signups" name="Регистрации" stroke="#cc2229" strokeWidth={2} dot={{ r: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <SectionTitle>Возврат пользователей</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-8)' }}>
        <MetricCard
          label="D1 — вернулись на следующий день"
          value={data.retention.days1.percent !== null ? `${data.retention.days1.percent}%` : '—'}
          hint={`Когорта: зарегистрировались 2–30 дней назад (${data.retention.days1.cohortSize} чел., без admin/test). "Вернулся" = было действие ровно на 1-й день после регистрации.`}
        />
        <MetricCard
          label="D7 — вернулись в течение 7 дней"
          value={data.retention.days7.percent !== null ? `${data.retention.days7.percent}%` : '—'}
          hint={`Когорта: зарегистрировались 8–30 дней назад (${data.retention.days7.cohortSize} чел., без admin/test). "Вернулся" = было действие в течение 7 дней после регистрации.`}
        />
        <MetricCard
          label="D30 — вернулись в течение 30 дней"
          value={data.retention.days30.percent !== null ? `${data.retention.days30.percent}%` : '—'}
          hint={`Когорта: зарегистрировались 31–90 дней назад (${data.retention.days30.cohortSize} чел., без admin/test). "Вернулся" = было действие в течение 30 дней после регистрации.`}
        />
      </div>

      <SectionTitle>Пользователи</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-8)' }}>
        <SegmentCard label="Новые" value={data.userSegments.new} href="/admin/users?status=new" />
        <SegmentCard label="Активные" value={data.userSegments.active} href="/admin/users?status=active" />
        <SegmentCard label="Вернувшиеся" value={data.userSegments.returning} href="/admin/users?status=returning" />
        <SegmentCard label="Неактивные" value={data.userSegments.inactive} href="/admin/users?status=inactive" />
      </div>

      <SectionTitle>AI (Помощник)</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <MetricCard
          label="Запросов с данными о токенах"
          value={data.ai.requestCount}
          hint={`из ${data.metrics.assistantUserMessages} вопросов всего за период — остальные заданы до включения сбора токенов`}
        />
        <MetricCard label="Input tokens" value={data.ai.inputTokens !== null ? data.ai.inputTokens.toLocaleString('ru-RU') : '—'} />
        <MetricCard label="Output tokens" value={data.ai.outputTokens !== null ? data.ai.outputTokens.toLocaleString('ru-RU') : '—'} />
        <MetricCard
          label="Ориентировочная стоимость"
          value={data.ai.estimatedCostUsd !== null ? `$${data.ai.estimatedCostUsd.toFixed(4)}` : '—'}
          hint={
            data.ai.requestCount === 0
              ? 'Нет данных о токенах за период'
              : data.ai.estimatedCostUsd === null
                ? 'Модель не найдена в таблице цен — обновите src/lib/admin/ai-cost.ts'
                : 'Оценка по прайс-листу Anthropic на момент разработки — сверьте актуальность'
          }
        />
      </div>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-8)' }}>
        Данные о токенах и стоимости собираются только для новых AI-запросов после включения аналитики.
        «—» означает отсутствие данных, а не нулевое значение.
      </div>

      <SectionTitle>Последняя активность</SectionTitle>
      <div style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
        {data.recentActivity.length === 0 && (
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: 0 }}>Пока нет активности.</p>
        )}
        {data.recentActivity.map((item, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              padding: '8px 0',
              borderBottom: i < data.recentActivity.length - 1 ? '1px solid var(--color-border)' : 'none',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            <span style={{ color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
              {new Date(item.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span style={{ color: 'var(--color-text)' }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', padding: 'var(--space-4)' }}>
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 'var(--font-size-md)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text)', margin: '0 0 var(--space-3)' }}>
      {children}
    </h2>
  );
}

function SegmentCard({ label, value, href }: { label: string; value: number; href: string }) {
  // Этап 2, п.9 — компактный переход от общей аналитики к /admin/users с
  // готовым фильтром по статусу. Не отдельный dashboard — просто число-ссылка.
  return (
    <a
      href={href}
      style={{
        display: 'block',
        background: '#fff',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
        textDecoration: 'none',
      }}
    >
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-brand-blue)' }}>{value}</div>
    </a>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)' }}>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text)' }}>{value}</div>
      {hint && <div style={{ fontSize: '0.7rem', color: 'var(--color-neutral-400)', marginTop: 4, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}

function FunnelCard({
  title,
  steps,
  note,
}: {
  title: string;
  steps: Array<{ step: string; count: number; percentOfPrevious: number | null }>;
  note?: string;
}) {
  return (
    <div style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
      <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text)', marginBottom: note ? 4 : 'var(--space-3)' }}>
        {title}
      </div>
      {note && (
        <div style={{ fontSize: '0.7rem', color: 'var(--color-neutral-400)', marginBottom: 'var(--space-3)', lineHeight: 1.4 }}>{note}</div>
      )}
      {steps.map((s, i) => (
        <div key={i} style={{ marginBottom: i < steps.length - 1 ? 8 : 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            <span>{s.step}</span>
            <span>
              {s.count}
              {s.percentOfPrevious !== null && <span style={{ color: 'var(--color-neutral-400)' }}> ({s.percentOfPrevious}%)</span>}
            </span>
          </div>
          <div style={{ height: 6, background: 'var(--color-neutral-100)', borderRadius: 999, marginTop: 3 }}>
            <div
              style={{
                height: '100%',
                borderRadius: 999,
                background: 'var(--color-brand-blue)',
                width: steps[0].count > 0 ? `${Math.max(4, (s.count / steps[0].count) * 100)}%` : '0%',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
