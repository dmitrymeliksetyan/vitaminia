import type { SupabaseClient } from '@supabase/supabase-js';
import { getServerSupabase } from '../assistant/server-supabase';
import { getRuntimeEnv } from '../assistant/runtime-env';

// ЭТАП 1 аналитики — доступ к /admin и /api/admin/*.
//
// Whitelist по user_id (не email — см. ТЗ часть 8: "предпочтительный
// вариант — whitelist по user_id, а не по email"), хранится в серверной
// переменной окружения ADMIN_USER_IDS (Node process.env, см.
// .env.example/shared/.env.production), список UUID через запятую.
//
// Определение пользователя — тем же способом, что и везде в проекте
// (getServerSupabase + auth.getUser(token)), никакого нового механизма.

export type AdminCheckResult =
  | { ok: true; userId: string; supabase: SupabaseClient }
  | { ok: false; status: 401 | 403 };

/**
 * Единственное место, парсящее ADMIN_USER_IDS (список UUID через запятую).
 * Переиспользуется и для проверки доступа (ниже), и в /api/admin/analytics
 * — для исключения admin/test-аккаунтов из продуктовой статистики (см.
 * "Правки Этапа 1 аналитики", п.6). Никакой второй копии списка нет.
 */
export function getAdminIds(locals: App.Locals): string[] {
  const env = getRuntimeEnv(locals);
  return (env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Infra v2, п.11 ТЗ ("ускорить админку" — "возможно проблема в
// middleware/авторизации") — каждый /api/admin/* роут вызывает
// checkAdminAccess() независимо, а один открытый экран админки почти
// всегда бьёт сразу в несколько таких роутов параллельно (например,
// /admin/editorial на монтировании одновременно дёргает registry/ideas/
// jobs/strategy-runs). auth.getUser(token) — это реальный сетевой запрос
// в Supabase Auth, так что 4-5 параллельных вызовов = 4-5 одинаковых
// сетевых обращений с одним и тем же токеном за одну и ту же секунду.
// Короткий in-memory кэш (несколько секунд) по конкретному access-токену
// убирает эту избыточность, ничего не ослабляя в самой проверке: токен
// всё ещё обязателен, whitelist по user_id проверяется как прежде, а TTL
// заведомо короче обычного времени жизни access-токена (~1 час), так что
// отозванный/истёкший токен отклоняется максимум на несколько секунд
// позже, чем при проверке без кэша.
const ADMIN_AUTH_CACHE_TTL_MS = 5_000;
type CachedAuthEntry = { result: AdminCheckResult; expiresAt: number };
const adminAuthCache = new Map<string, CachedAuthEntry>();

function cleanupExpiredAuthCache(now: number): void {
  // Дешёвая ленивая очистка — карта токенов в рамках одного Node-процесса
  // не должна расти бесконечно (см. Infra v2 п.1, постоянный Node-адаптер).
  if (adminAuthCache.size < 50) return;
  for (const [key, entry] of adminAuthCache) {
    if (entry.expiresAt <= now) adminAuthCache.delete(key);
  }
}

export async function checkAdminAccess(request: Request, locals: App.Locals): Promise<AdminCheckResult> {
  const authHeader = request.headers.get('authorization') ?? '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) return { ok: false, status: 401 };

  const now = Date.now();
  cleanupExpiredAuthCache(now);
  const cached = adminAuthCache.get(accessToken);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const identityClient = getServerSupabase(accessToken);
  let userId: string;
  try {
    const { data, error } = await identityClient.auth.getUser(accessToken);
    if (error || !data?.user) {
      const result: AdminCheckResult = { ok: false, status: 401 };
      adminAuthCache.set(accessToken, { result, expiresAt: now + ADMIN_AUTH_CACHE_TTL_MS });
      return result;
    }
    userId = data.user.id;
  } catch {
    return { ok: false, status: 401 };
  }

  const adminIds = getAdminIds(locals);

  const result: AdminCheckResult = !adminIds.includes(userId)
    ? { ok: false, status: 403 }
    : { ok: true, userId, supabase: identityClient };

  adminAuthCache.set(accessToken, { result, expiresAt: now + ADMIN_AUTH_CACHE_TTL_MS });
  return result;
}
