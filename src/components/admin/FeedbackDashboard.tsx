import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/auth/browser-supabase';
import AdminNav from './AdminNav';
import { RefreshingHint, RetryBanner } from './dashboard-shared';
import { hasRecentAdminOk, markAdminOk, clearAdminSessionCache, getCachedData, setCachedData } from '../../lib/admin/client-session-cache';

// Аналитика и админка, Этап 2 — /admin/feedback.
//
// Задача: видеть сообщения пользователей и не терять их — не helpdesk, без
// ответов/рассылок/чата/тикетов/назначений (см. ограничения ТЗ). Единственное
// разрешённое действие — смена статуса (Новое/В работе/Закрыто), через
// PATCH /api/admin/feedback/[id].
//
// ТЗ "Убрать повторную проверку доступа и Load failed" — см.
// src/lib/admin/client-session-cache.ts.

type Phase = 'checking' | 'loading' | 'unauthorized' | 'forbidden' | 'ready' | 'error';
interface FeedbackCache { items: FeedbackItem[]; total: number }
type StatusFilter = 'all' | 'new' | 'read' | 'archived';

interface FeedbackItem {
  id: string;
  createdAt: string;
  source: string | null;
  message: string;
  who: string;
  status: string;
}

const STATUS_LABELS: Record<string, string> = {
  new: 'Новое',
  read: 'В работе',
  replied: 'Отвечено',
  archived: 'Закрыто',
};

const STATUS_COLOR: Record<string, string> = {
  new: 'var(--color-brand-blue)',
  read: 'var(--color-severity-medium)',
  replied: 'var(--color-severity-low)',
  archived: 'var(--color-neutral-400)',
};

const LIMIT = 20;

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

export default function FeedbackDashboard() {
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<StatusFilter>('all');
  const cacheKey = `feedback:${status}:${offset}`;
  const [phase, setPhase] = useState<Phase>(() => (getCachedData<FeedbackCache>(cacheKey) ? 'ready' : hasRecentAdminOk() ? 'loading' : 'checking'));
  const [errorMessage, setErrorMessage] = useState('');
  const [items, setItems] = useState<FeedbackItem[]>(() => getCachedData<FeedbackCache>(cacheKey)?.items ?? []);
  const [total, setTotal] = useState(() => getCachedData<FeedbackCache>(cacheKey)?.total ?? 0);
  const [token, setToken] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedData<FeedbackCache>(cacheKey);
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
        return setPhase('unauthorized');
      }
      setToken(session.access_token);

      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));

      try {
        const res = await fetch(`/api/admin/feedback?${params.toString()}`, {
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
          console.warn('[admin/feedback] сервер вернул ok:false —', json.error);
          if (cached) setLoadError(json.error);
          else {
            setErrorMessage(json.error);
            setPhase('error');
          }
          return;
        }
        markAdminOk();
        setCachedData<FeedbackCache>(cacheKey, { items: json.items, total: json.total });
        setItems(json.items);
        setTotal(json.total);
        setPhase('ready');
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Не удалось загрузить обратную связь';
        console.warn('[admin/feedback] fetch завершился ошибкой:', err);
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
  }, [status, offset, reloadTick]);

  useEffect(() => {
    setOffset(0);
  }, [status]);

  async function updateStatus(id: string, newStatus: 'new' | 'read' | 'archived') {
    if (!token) return;
    setUpdatingId(id);
    try {
      const res = await fetch(`/api/admin/feedback/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const json = await res.json();
      if (json.ok) {
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: newStatus } : it)));
      }
    } finally {
      setUpdatingId(null);
    }
  }

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
  if (phase === 'error') return <Centered>Не удалось загрузить обратную связь: {errorMessage}</Centered>;

  return (
    <div style={{ maxWidth: 'var(--container-content)', margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}>
      <AdminNav current="feedback" />
      <RefreshingHint show={refreshing} />
      {loadError && <RetryBanner message={loadError} onRetry={() => setReloadTick((t) => t + 1)} />}
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-semibold)', margin: '0 0 4px', color: 'var(--color-text)' }}>
        Обратная связь
      </h1>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: '0 0 var(--space-5)', maxWidth: 640 }}>
        Сообщения от пользователей сайта. Меняйте статус, чтобы отмечать прогресс — ответы отсюда не отправляются.
      </p>

      <div style={{ display: 'flex', gap: 4, background: 'var(--color-neutral-100)', padding: 4, borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-4)', width: 'fit-content' }}>
        {(['all', 'new', 'read', 'archived'] as StatusFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            style={{
              fontSize: 'var(--font-size-sm)',
              padding: '6px 14px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              background: status === s ? '#fff' : 'transparent',
              color: status === s ? 'var(--color-brand-blue)' : 'var(--color-text-secondary)',
              fontWeight: status === s ? 'var(--font-weight-medium)' : 'var(--font-weight-regular)',
              cursor: 'pointer',
              boxShadow: status === s ? 'var(--shadow-sm)' : 'none',
            }}
          >
            {s === 'all' ? 'Все' : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-3)' }}>
        Найдено: {total}
      </div>

      {items.length === 0 && (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', padding: 'var(--space-4)' }}>
          Сообщений с этим статусом нет.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {items.map((f) => (
          <div key={f.id} style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                {fmtDateTime(f.createdAt)} · {f.who}
                {f.source && <span> · {f.source}</span>}
              </div>
              <span style={{ color: STATUS_COLOR[f.status] ?? 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-medium)' }}>
                {STATUS_LABELS[f.status] ?? f.status}
              </span>
            </div>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', margin: '0 0 var(--space-3)', whiteSpace: 'pre-wrap' }}>{f.message}</p>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              {(['new', 'read', 'archived'] as const).map((s) => (
                <button
                  key={s}
                  disabled={f.status === s || updatingId === f.id}
                  onClick={() => updateStatus(f.id, s)}
                  style={{
                    fontSize: 'var(--font-size-xs)',
                    padding: '5px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border)',
                    background: f.status === s ? 'var(--color-neutral-100)' : '#fff',
                    color: f.status === s ? 'var(--color-neutral-400)' : 'var(--color-brand-blue)',
                    cursor: f.status === s || updatingId === f.id ? 'default' : 'pointer',
                  }}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-4)' }}>
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))} style={pagerButtonStyle(offset === 0)}>
          ← Назад
        </button>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
          {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + LIMIT, total)}`} из {total}
        </span>
        <button disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)} style={pagerButtonStyle(offset + LIMIT >= total)}>
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
