// ТЗ "Убрать повторную «Проверку доступа» и ошибки Load failed в админке".
//
// НАЙДЕННАЯ ПРИЧИНА (см. аудит): каждый раздел админки — ОТДЕЛЬНАЯ
// Astro-страница, а переходы между ними (AdminNav.tsx, EditorialSubNav в
// EditorialApp.tsx, ссылки внутри LibraryApp.tsx и т.д.) — обычные
// `<a href>`, то есть ПОЛНАЯ перезагрузка браузера, а не client-side
// маршрутизация внутри одного React-приложения. Из-за этого:
//   - весь JS каждой страницы выполняется заново с нуля — никакая
//     in-memory переменная (module-level кэш, React-контекст,
//     useRef/useState) не может пережить переход, потому что сам JS-модуль
//     создаётся заново при каждой загрузке страницы;
//   - каждый из 7 admin-компонентов (AdminDashboard/EditorialApp/
//     LibraryApp/UsersDashboard/UserDetail/FeedbackDashboard/SeoMonitorApp)
//     независимо стартует с phase='checking' и заново дёргает
//     supabase.auth.getSession() + API — отсюда повторный экран "Проверка
//     доступа…" при КАЖДОМ переходе и полностью пустой экран, пока не
//     резолвится хотя бы один сетевой запрос.
//
// Единственное, что реально переживает полную перезагрузку страницы в
// браузере — sessionStorage (переживает переходы, НЕ переживает закрытие
// вкладки/браузера — то есть в точности "на время сессии", как просит ТЗ).
// Используем его для двух вещей:
//   1. Отметка "доступ подтверждён недавно" — чтобы НЕ показывать
//      блокирующий полноэкранный "Проверка доступа…" при обычном переходе
//      между разделами, если мы только что (в пределах TTL) реально
//      подтвердили доступ. Сама проверка при этом никуда не девается —
//      supabase.auth.getSession() и запрос к API всё равно выполняются на
//      КАЖДОЙ странице, просто НЕ блокируют отрисовку интерфейса — см.
//      ниже clearAdminSessionCache(), вызывается немедленно при реальном
//      401/403, так что эта оптимизация никогда не может скрыть настоящую
//      потерю доступа дольше одного фонового запроса.
//   2. Последний успешный ответ каждого запроса (getCachedData/
//      setCachedData) — чтобы отрисовать интерфейс СРАЗУ на старых данных
//      (stale-while-revalidate), пока свежие данные грузятся в фоне, вместо
//      пустого экрана.
//
// Ничего в серверной проверке (checkAdminAccess(), src/lib/admin/auth.ts)
// не меняется и не ослабляется — это чисто клиентская UX-оптимизация поверх
// той же самой обязательной серверной проверки на каждый API-запрос.

const OK_KEY = 'medizin_admin_ok_at';
// 5 минут — достаточно, чтобы не мигать "Проверка доступа…" при обычной
// работе (переходы между разделами занимают секунды), но заведомо короче,
// чем реалистичный сценарий "человек ушёл и потерял доступ, не заметив".
const OK_TTL_MS = 5 * 60_000;
const DATA_PREFIX = 'medizin_admin_cache:';

function safeSessionStorage(): Storage | null {
  try {
    // В приватном режиме/при отключённом storage sessionStorage может
    // кидать при обращении — просто честно проверяем доступ каждый раз.
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function hasRecentAdminOk(): boolean {
  const storage = safeSessionStorage();
  if (!storage) return false;
  try {
    const raw = storage.getItem(OK_KEY);
    if (!raw) return false;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at < OK_TTL_MS;
  } catch {
    return false;
  }
}

export function markAdminOk(): void {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(OK_KEY, String(Date.now()));
  } catch {
    /* переполнен/недоступен sessionStorage — не критично, просто не будет кэша */
  }
}

/**
 * Вызывать сразу при первом же реальном 401/403 от сервера — гарантирует,
 * что оптимистичный рендер по кэшу никогда не переживает настоящую потерю
 * доступа дольше одного фонового запроса, и что старые (возможно, чужие,
 * если это общий компьютер) данные не всплывут в следующей сессии.
 */
export function clearAdminSessionCache(): void {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(OK_KEY);
    const toRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(DATA_PREFIX)) toRemove.push(k);
    }
    toRemove.forEach((k) => storage.removeItem(k));
  } catch {
    /* не критично */
  }
}

export function getCachedData<T>(key: string): T | null {
  const storage = safeSessionStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(DATA_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function setCachedData<T>(key: string, value: T): void {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(DATA_PREFIX + key, JSON.stringify(value));
  } catch {
    /* лимит sessionStorage (обычно 5-10 МБ) или недоступен — не критично, просто не кэшируем этот ответ */
  }
}
