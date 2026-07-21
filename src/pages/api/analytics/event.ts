import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../../lib/assistant/server-supabase';
import { getServiceRoleSupabase } from '../../../lib/server/service-role-supabase';
import { getRuntimeEnv } from '../../../lib/assistant/runtime-env';
import { isKnownEvent, sanitizeMetadata, sanitizePagePath, sanitizeId } from '../../../lib/analytics/schema';

// ЭТАП 1 аналитики — единственный путь записи в analytics_events.
//
// Контракт (POST, JSON): { event_name, anonymous_id?, session_id?, page_path?, metadata? }
// Ответ ВСЕГДА { ok: true|false } без деталей — клиентский trackEvent()
// (см. src/lib/analytics/track-event.ts) не должен и не может ничего с
// ошибкой сделать, это фоновая телеметрия, а не часть продукта.
//
// Тот же принцип "никогда не 5xx от себя", что и в /api/assistant/chat и
// /api/feedback — см. историю правок после инцидента с Cloudflare 502.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    return await handleEvent(request, locals);
  } catch {
    return json({ ok: false });
  }
};

async function handleEvent(request: Request, locals: App.Locals): Promise<Response> {
  let body: {
    event_name?: string;
    anonymous_id?: string;
    session_id?: string;
    page_path?: string;
    metadata?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false });
  }

  // 1–4. Whitelist события + фильтрация/валидация metadata и page_path —
  // см. src/lib/analytics/schema.ts, единственный источник правды.
  if (!isKnownEvent(body.event_name)) {
    return json({ ok: false });
  }
  const eventName = body.event_name;
  const metadata = sanitizeMetadata(eventName, body.metadata);
  const pagePath = sanitizePagePath(body.page_path);
  const anonymousId = sanitizeId(body.anonymous_id);
  const sessionId = sanitizeId(body.session_id);

  // 5. Пользователь — тем же способом, что и везде в проекте: по access
  //    token, никогда не доверяя user_id от клиента напрямую (клиент его и
  //    не присылает — trackEvent() даже не собирает такое поле).
  let userId: string | null = null;
  const authHeader = request.headers.get('authorization') ?? '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (accessToken) {
    try {
      const identityClient = getServerSupabase(accessToken);
      const { data: userData } = await identityClient.auth.getUser(accessToken);
      if (userData?.user) userId = userData.user.id;
    } catch {
      // Битый токен — пишем событие анонимным, не блокируем аналитику.
    }
  }

  // 6. Секрет и запись — переиспользуем тот же service-role helper, что и
  //    /api/feedback.ts (см. src/lib/server/service-role-supabase.ts).
  const env = getRuntimeEnv(locals);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return json({ ok: false });
  }

  const admin = getServiceRoleSupabase(serviceRoleKey);
  const { error } = await admin.from('analytics_events').insert({
    event_name: eventName,
    user_id: userId,
    anonymous_id: anonymousId,
    session_id: sessionId,
    page_path: pagePath,
    metadata,
  });

  return json({ ok: !error });
}
