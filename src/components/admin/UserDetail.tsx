import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/auth/browser-supabase';
import AdminNav from './AdminNav';
import { RefreshingHint, RetryBanner } from './dashboard-shared';
import { hasRecentAdminOk, markAdminOk, clearAdminSessionCache, getCachedData, setCachedData } from '../../lib/admin/client-session-cache';

// Аналитика и админка, Этап 2 — /admin/users/[id].
//
// Карточка ИСПОЛЬЗОВАНИЯ ПРОДУКТА, не медицинская карта (см. п.5 ТЗ и
// ограничения). Данные — из /api/admin/users/[id], которая уже фильтрует
// всё до чисел/дат/фактов, никакого медицинского содержимого сюда и не
// попадает даже теоретически.
//
// ТЗ "Убрать повторную проверку доступа и Load failed" — см.
// src/lib/admin/client-session-cache.ts.

type Phase = 'checking' | 'loading' | 'unauthorized' | 'forbidden' | 'notfound' | 'ready' | 'error';
interface UserDetailCache {
  user: any;
  timeline: Array<{ label: string; at: string }>;
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

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function UserDetail({ userId }: { userId: string }) {
  const cacheKey = `user-detail:${userId}`;
  const [phase, setPhase] = useState<Phase>(() => (getCachedData<UserDetailCache>(cacheKey) ? 'ready' : hasRecentAdminOk() ? 'loading' : 'checking'));
  const [errorMessage, setErrorMessage] = useState('');
  const [user, setUser] = useState<any>(() => getCachedData<UserDetailCache>(cacheKey)?.user ?? null);
  const [timeline, setTimeline] = useState<Array<{ label: string; at: string }>>(() => getCachedData<UserDetailCache>(cacheKey)?.timeline ?? []);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedData<UserDetailCache>(cacheKey);
    if (cached) {
      setUser(cached.user);
      setTimeline(cached.timeline);
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

      try {
        const res = await fetch(`/api/admin/users/${userId}`, {
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
          console.warn('[admin/user-detail] сервер вернул ok:false —', json.error);
          if (cached && json.error !== 'Пользователь не найден') {
            setLoadError(json.error);
          } else {
            setPhase(json.error === 'Пользователь не найден' ? 'notfound' : 'error');
            setErrorMessage(json.error);
          }
          return;
        }
        markAdminOk();
        setCachedData<UserDetailCache>(cacheKey, { user: json.user, timeline: json.timeline });
        setUser(json.user);
        setTimeline(json.timeline);
        setPhase('ready');
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Не удалось загрузить карточку';
        console.warn('[admin/user-detail] fetch завершился ошибкой:', err);
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
  }, [userId, reloadTick]);

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
  if (phase === 'notfound') return <Centered>Пользователь не найден.</Centered>;
  if (phase === 'error') return <Centered>Не удалось загрузить карточку: {errorMessage}</Centered>;
  if (!user) return null;

  return (
    <div style={{ maxWidth: 'var(--container-content)', margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}>
      <AdminNav current="users" />
      <RefreshingHint show={refreshing} />
      {loadError && <RetryBanner message={loadError} onRetry={() => setReloadTick((t) => t + 1)} />}
      <a href="/admin/users" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-brand-blue)' }}>
        ← Все пользователи
      </a>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', margin: 'var(--space-3) 0 var(--space-6)' }}>
        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-semibold)', margin: 0, color: 'var(--color-text)', fontVariantNumeric: 'tabular-nums' }}>
          Пользователь {user.shortId}
        </h1>
        <span style={{ color: STATUS_COLOR[user.status], fontWeight: 'var(--font-weight-medium)', fontSize: 'var(--font-size-sm)' }}>
          {STATUS_LABELS[user.status]}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-8)' }}>
        <MetricCard label="Регистрация" value={fmtDateTime(user.registeredAt)} />
        <MetricCard label="Последняя активность" value={fmtDateTime(user.lastActiveAt)} />
        <MetricCard label="Активных дней" value={user.activeDaysCount} />
        <MetricCard label="Использовал Карту" value={user.usedCard ? 'Да' : 'Нет'} />
        <MetricCard label="Разделов Карты заполнено" value={`${user.cardSectionsCount} из 5`} />
        <MetricCard label="Использовал Помощника" value={user.usedAssistant ? 'Да' : 'Нет'} />
        <MetricCard label="Вопросов Помощнику" value={user.assistantMessagesCount} />
        <MetricCard label="Дневников" value={user.journalsCount} />
        <MetricCard label="Записей в дневниках" value={user.journalEntriesCount} />
      </div>

      <SectionTitle>Основные продуктовые события</SectionTitle>
      <div
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-secondary)',
          background: 'var(--color-bg-info)',
          border: '1px solid var(--color-border-info)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-3) var(--space-4)',
          marginBottom: 'var(--space-4)',
        }}
      >
        Показаны только тип и время действия — без содержания (какой именно раздел Карты, текст вопроса Помощнику,
        название дневника и т.п. здесь никогда не отображаются).
      </div>
      <div style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
        {timeline.map((item, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              padding: '8px 0',
              borderBottom: i < timeline.length - 1 ? '1px solid var(--color-border)' : 'none',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            <span style={{ color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{fmtDateTime(item.at)}</span>
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

function MetricCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ background: '#fff', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)' }}>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--font-size-md)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text)' }}>{value}</div>
    </div>
  );
}
