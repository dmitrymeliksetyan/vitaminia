import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/auth/browser-supabase';
import AdminNav from './AdminNav';
import { RefreshingHint, RetryBanner } from './dashboard-shared';
import { hasRecentAdminOk, markAdminOk, clearAdminSessionCache, getCachedData, setCachedData } from '../../lib/admin/client-session-cache';

// Аналитика и админка, Этап 2 — /admin/users.
//
// Задача: "Кто зарегистрирован и пользуется ли человек продуктом?" — не
// медицинская карта, не CRM. Источник данных — ОДИН запрос к
// /api/admin/users (тот же паттерн auth/фетча, что и AdminDashboard.tsx/
// ContentDashboard.tsx: Bearer-токен из supabase.auth.getSession(),
// сервер сам решает, что можно вернуть).

// 'loading' vs 'checking' — см. src/lib/admin/client-session-cache.ts:
// 'checking' только если доступ ещё НИ РАЗУ не подтверждался в этой
// сессии; если подтверждался недавно, но кэша данных под этот набор
// фильтров ещё нет — нейтральная "Загрузка…", а не "Проверка доступа…".
type Phase = 'checking' | 'loading' | 'unauthorized' | 'forbidden' | 'ready' | 'error';
type StatusFilter = 'all' | 'new' | 'active' | 'returning' | 'inactive';

interface UserRow {
  id: string;
  shortId: string;
  registeredAt: string;
  lastActiveAt: string;
  activeDaysCount: number;
  usedCard: boolean;
  cardSectionsCount: number;
  usedAssistant: boolean;
  assistantMessagesCount: number;
  journalsCount: number;
  journalEntriesCount: number;
  status: StatusFilter;
}

const STATUS_LABELS: Record<string, string> = {
  new: 'Новый',
  active: 'Активный',
  returning: 'Вернувшийся',
  inactive: 'Неактивный',
};

const STATUS_COLOR: Record<string, string> = {
  new: 'var(--color-brand-blue)',
  active: 'var(--color-severity-low)',
  returning: 'var(--color-severity-medium)',
  inactive: 'var(--color-neutral-400)',
};

const STATUS_HINT: Record<string, string> = {
  new: 'Зарегистрирован 3 дня назад или позже.',
  active: 'Последнее действие за последние 3 дня, без явных долгих перерывов.',
  returning: 'Аккаунту больше 2 недель, был перерыв, но недавно снова появилась активность.',
  inactive: 'Последнее действие было более 3 дней назад.',
};

const LIMIT = 25;

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function getInitialStatus(): StatusFilter {
  if (typeof window === 'undefined') return 'all';
  const q = new URLSearchParams(window.location.search).get('status');
  return (['new', 'active', 'returning', 'inactive'] as readonly string[]).includes(q ?? '') ? (q as StatusFilter) : 'all';
}

export default function UsersDashboard() {
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  const [status, setStatus] = useState<StatusFilter>(getInitialStatus);
  const [usedCard, setUsedCard] = useState(false);
  const [usedAssistant, setUsedAssistant] = useState(false);
  const [hasJournal, setHasJournal] = useState(false);
  const [search, setSearch] = useState('');

  const buildParams = () => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (usedCard) params.set('usedCard', 'true');
    if (usedAssistant) params.set('usedAssistant', 'true');
    if (hasJournal) params.set('hasJournal', 'true');
    if (search.trim()) params.set('search', search.trim());
    params.set('limit', String(LIMIT));
    params.set('offset', String(offset));
    return params;
  };
  const cacheKey = `users:${buildParams().toString()}`;
  type CachedList = { items: UserRow[]; total: number };

  const [phase, setPhase] = useState<Phase>(() => (getCachedData<CachedList>(cacheKey) ? 'ready' : 'checking'));
  const [errorMessage, setErrorMessage] = useState('');
  const [items, setItems] = useState<UserRow[]>(() => getCachedData<CachedList>(cacheKey)?.items ?? []);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedData<CachedList>(cacheKey);
    if (cached) {
      setItems(cached.items);
      setTotal(cached.total);
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

      const params = buildParams();

      try {
        const res = await fetch(`/api/admin/users?${params.toString()}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (cancelled) return;
        if (res.status === 401) {
          clearAdminSessionCache();
          return setPhase('unauthorized');
        }
        if (res.status === 403) {
          clearAdminSessionCache();
          return setPhase('forbidden');
        }

        const json = await res.json();
        if (!json.ok) {
          console.warn('[admin/users] сервер вернул ok:false —', json.error);
          if (cached) setLoadError(json.error);
          else {
            setErrorMessage(json.error);
            setPhase('error');
          }
          return;
        }
        markAdminOk();
        setCachedData<CachedList>(cacheKey, { items: json.items, total: json.total });
        setItems(json.items);
        setTotal(json.total);
        setPhase('ready');
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Не удалось загрузить список';
        console.warn('[admin/users] fetch завершился ошибкой:', err);
        if (cached) setLoadError(msg);
        else {
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
  }, [status, usedCard, usedAssistant, hasJournal, search, offset, reloadTick]);

  // Смена любого фильтра — обратно на первую страницу.
  useEffect(() => {
    setOffset(0);
  }, [status, usedCard, usedAssistant, hasJournal, search]);

  if (phase === 'checking') return <Centered>Проверка доступа…</Centered>;
  if (phase === 'loading') return <Centered>Загрузка…</Centered>;
  if (phase === 'unauthorized')
    return (
      <Centered>
        Нужно войти в аккаунт.{' '}
        <a href="/auth/login" style={{ color: 'var(--color-brand-blue)' }}>
          Войти
        </a>
      </Centered>
    );
  if (phase === 'forbidden') return <Centered>Доступ к этой странице ограничен.</Centered>;
  if (phase === 'error') return <Centered>Не удалось загрузить список: {errorMessage}</Centered>;

  return (
    <div style={{ maxWidth: 'var(--container-wide)', margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}>
      <AdminNav current="users" />
      <RefreshingHint show={refreshing} />
      {loadError && <RetryBanner message={loadError} onRetry={() => setReloadTick((t) => t + 1)} />}
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-semibold)', margin: '0 0 4px', color: 'var(--color-text)' }}>
        Пользователи
      </h1>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: '0 0 var(--space-5)', maxWidth: 640 }}>
        Кто зарегистрирован и пользуется продуктом. Здесь показаны только факты использования функций — без личных и
        медицинских данных.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
        <Select
          value={status}
          onChange={(v) => setStatus(v as StatusFilter)}
          options={[
            { value: 'all', label: 'Все' },
            { value: 'new', label: 'Новые' },
            { value: 'active', label: 'Активные' },
            { value: 'returning', label: 'Вернувшиеся' },
            { value: 'inactive', label: 'Неактивные' },
          ]}
        />
        <Toggle checked={usedCard} onChange={setUsedCard} label="Использовали Карту" />
        <Toggle checked={usedAssistant} onChange={setUsedAssistant} label="Использовали Помощника" />
        <Toggle checked={hasJournal} onChange={setHasJournal} label="Создали дневник" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по ID (…7f81)"
          style={{
            fontSize: 'var(--font-size-sm)',
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)',
            minWidth: 200,
          }}
        />
      </div>

      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-3)' }}>
        Найдено: {total}
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border)', textAlign: 'left' }}>
              <Th>Пользователь</Th>
              <Th>Регистрация</Th>
              <Th>Последняя активность</Th>
              <Th>Карта</Th>
              <Th>Помощник</Th>
              <Th>Дневник</Th>
              <Th>Статус</Th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 'var(--space-4)', color: 'var(--color-text-secondary)' }}>
                  Никого не найдено по этим фильтрам.
                </td>
              </tr>
            )}
            {items.map((u) => (
              <tr key={u.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <Td>
                  <a href={`/admin/users/${u.id}`} style={{ color: 'var(--color-brand-blue)', fontVariantNumeric: 'tabular-nums' }}>
                    {u.shortId}
                  </a>
                </Td>
                <Td>{fmtDate(u.registeredAt)}</Td>
                <Td>{fmtDate(u.lastActiveAt)}</Td>
                <Td>{u.usedCard ? `Да (${u.cardSectionsCount})` : 'Нет'}</Td>
                <Td>{u.usedAssistant ? `Да (${u.assistantMessagesCount})` : 'Нет'}</Td>
                <Td>{u.journalsCount > 0 ? u.journalsCount : '—'}</Td>
                <Td>
                  <span title={STATUS_HINT[u.status]} style={{ color: STATUS_COLOR[u.status], fontWeight: 'var(--font-weight-medium)' }}>
                    {STATUS_LABELS[u.status]}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-4)' }}>
        <button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - LIMIT))}
          style={pagerButtonStyle(offset === 0)}
        >
          ← Назад
        </button>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
          {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + LIMIT, total)}`} из {total}
        </span>
        <button
          disabled={offset + LIMIT >= total}
          onClick={() => setOffset(offset + LIMIT)}
          style={pagerButtonStyle(offset + LIMIT >= total)}
        >
          Дальше →
        </button>
      </div>
    </div>
  );
}

function pagerButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 'var(--font-size-sm)',
    padding: '6px 14px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border)',
    background: disabled ? 'var(--color-neutral-100)' : '#fff',
    color: disabled ? 'var(--color-neutral-400)' : 'var(--color-brand-blue)',
    cursor: disabled ? 'default' : 'pointer',
  };
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', padding: 'var(--space-4)' }}>
      {children}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: '10px 14px', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', whiteSpace: 'nowrap' }}>
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>{children}</td>;
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        fontSize: 'var(--font-size-sm)',
        padding: '8px 10px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border)',
        background: '#fff',
        color: 'var(--color-text)',
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
