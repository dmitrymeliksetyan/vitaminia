import { supabase } from '../auth/browser-supabase';
import type { AnalyticsEventName } from './schema';

// ЭТАП 1 аналитики — единый клиентский helper.
//
// Требования из ТЗ, все учтены ниже:
//   - не блокирует интерфейс (нет await на стороне вызывающего кода);
//   - ошибка аналитики никогда не всплывает пользователю (silent catch);
//   - anonymous_id/session_id — обычные случайные ID, НЕ fingerprinting;
//   - учитывает Astro client-side hydration (ленивая инициализация ID
//     только при первом реальном вызове, а не на каждом импорте модуля).
//
// Дедупликация от повторного вызова из-за React re-render — ответственность
// вызывающего кода (например, useRef-флаг "уже отследили" в компоненте),
// а не этого helper'а: generic trackEvent() должен оставаться простым
// fire-and-forget примитивом без скрытого стейта по имени события.

const ANONYMOUS_ID_KEY = 'medizin_analytics_anonymous_id';
const SESSION_ID_KEY = 'medizin_analytics_session_id';

function getOrCreateId(storage: Storage, key: string): string {
  try {
    const existing = storage.getItem(key);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    storage.setItem(key, fresh);
    return fresh;
  } catch {
    // storage недоступен (приватный режим и т.п.) — генерируем разовый ID,
    // просто не переживёт этот вызов. Не критично для fire-and-forget телеметрии.
    return crypto.randomUUID();
  }
}

function getAnonymousId(): string {
  return getOrCreateId(localStorage, ANONYMOUS_ID_KEY);
}

function getSessionId(): string {
  return getOrCreateId(sessionStorage, SESSION_ID_KEY);
}

/**
 * Отправляет продуктовое событие. Не блокирует вызывающий код — ничего не
 * нужно await'ить, ошибки никогда не выбрасываются наружу.
 */
export function trackEvent(eventName: AnalyticsEventName, metadata?: Record<string, string | boolean>): void {
  // Вся работа — внутри async IIFE, чтобы вызывающий код не получал Promise
  // и не был искушён поставить await перед навигацией/сохранением.
  (async () => {
    try {
      let authHeader: string | undefined;
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session) authHeader = `Bearer ${session.access_token}`;
      } catch {
        // Нет сессии — событие уйдёт анонимным, это нормально.
      }

      await fetch('/api/analytics/event', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          event_name: eventName,
          anonymous_id: getAnonymousId(),
          session_id: getSessionId(),
          page_path: window.location.pathname,
          metadata: metadata ?? {},
        }),
        keepalive: true, // событие успевает уйти, даже если сразу происходит навигация
      });
    } catch {
      // Аналитика никогда не должна быть заметна пользователю — молча гасим.
    }
  })();
}
