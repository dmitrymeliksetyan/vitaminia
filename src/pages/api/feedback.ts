import type { APIRoute } from 'astro';
import { getServerSupabase } from '../../lib/assistant/server-supabase';
import { getServiceRoleSupabase } from '../../lib/server/service-role-supabase';
import { sendFeedbackEmail } from '../../lib/feedback/resend';
import { getRuntimeEnv } from '../../lib/assistant/runtime-env';

// Форма обратной связи — см. ТЗ "MEDIZIN.RU — форма обратной связи".
//
// Контракт запроса (POST, JSON):
//   { name?, reply_email?, message, page_url?, website? }
// `website` — honeypot-поле, невидимое обычному пользователю (см. FeedbackModal.astro).
// Заголовок `Authorization: Bearer <supabase access_token>` — опциональный
// (анонимные пользователи тоже могут отправлять обратную связь). Если
// заголовок есть, сервер сам определяет user_id/user_email по токену —
// клиент их никогда не присылает как доверенные поля (см. п.3 ТЗ).
//
// Контракт ответа — ВСЕГДА безопасный, без внутренних деталей:
//   Успех:  { ok: true }
//   Отказ:  { ok: false, error: "Не удалось отправить сообщение" }
//
// Тот же принцип "никогда не 5xx от себя", что и в /api/assistant/chat
// (см. историю правок после инцидента с Cloudflare 502) — все ожидаемые
// отказы кодируются как HTTP 200 { ok: false }, кроме действительно
// клиентских ошибок (400 — невалидный запрос).

export const prerender = false;

const MAX_NAME = 100;
const MAX_REPLY_EMAIL = 254;
const MIN_MESSAGE = 3;
const MAX_MESSAGE = 5000;
const MAX_PAGE_URL = 2048;
const MAX_USER_AGENT = 512;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function genericFailure(): Response {
  // Намеренно один и тот же безопасный текст для любой внутренней ошибки —
  // см. п.2 ТЗ: "не показывать пользователю ошибки Supabase/Resend/stack trace".
  return json({ ok: false, error: 'Не удалось отправить сообщение' });
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    return await handleFeedback(request, locals);
  } catch {
    // Последняя линия защиты — см. ту же логику в /api/assistant/chat.
    return genericFailure();
  }
};

async function handleFeedback(request: Request, locals: App.Locals): Promise<Response> {
  // 1. Content-Type / JSON.
  let body: {
    name?: string;
    reply_email?: string;
    message?: string;
    page_url?: string;
    website?: string; // honeypot
  };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Некорректный запрос' }, 400);
  }

  // 2. Honeypot — если заполнено, это бот. Тихо возвращаем успех, ничего не
  //    сохраняем и не отправляем — не даём боту понять, что он пойман.
  if (body.website && body.website.trim() !== '') {
    return json({ ok: true });
  }

  // 3. Валидация полей (п.2, п.6 ТЗ).
  const name = body.name?.trim() || null;
  const replyEmail = body.reply_email?.trim() || null;
  const message = body.message?.trim() || '';

  if (name && name.length > MAX_NAME) {
    return json({ ok: false, error: 'Слишком длинное имя' }, 400);
  }
  if (replyEmail) {
    if (replyEmail.length > MAX_REPLY_EMAIL || !EMAIL_PATTERN.test(replyEmail)) {
      return json({ ok: false, error: 'Некорректный email' }, 400);
    }
  }
  if (message.length < MIN_MESSAGE || message.length > MAX_MESSAGE) {
    return json({ ok: false, error: 'Сообщение должно быть от 3 до 5000 символов' }, 400);
  }

  const pageUrl = (body.page_url?.trim() || null)?.slice(0, MAX_PAGE_URL) ?? null;
  const userAgent = (request.headers.get('user-agent') || null)?.slice(0, MAX_USER_AGENT) ?? null;

  // 4. Определяем пользователя по access token — НИКОГДА не доверяем
  //    user_id/user_email от клиента напрямую (их клиент и не присылает —
  //    сама форма их не собирает). Токен опционален: анонимные тоже могут
  //    отправлять фидбек.
  let userId: string | null = null;
  let userEmail: string | null = null;
  const authHeader = request.headers.get('authorization') ?? '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (accessToken) {
    try {
      const identityClient = getServerSupabase(accessToken);
      const { data: userData } = await identityClient.auth.getUser(accessToken);
      if (userData?.user) {
        userId = userData.user.id;
        userEmail = userData.user.email ?? null;
      }
    } catch {
      // Битый/просроченный токен — просто считаем отправителя анонимным,
      // это не повод отказывать в отправке обратной связи.
    }
  }

  // 5. Секреты — только из серверного env (Cloudflare), никогда не PUBLIC_.
  const env = getRuntimeEnv(locals);
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return genericFailure();
  }

  // 6. Сохраняем в Supabase — ЕДИНСТВЕННЫЙ путь записи в feedback_messages
  //    (RLS блокирует anon/authenticated полностью, см. миграцию 004).
  const admin = getServiceRoleSupabase(serviceRoleKey);
  const { data: inserted, error: insertError } = await admin
    .from('feedback_messages')
    .insert({
      user_id: userId,
      user_email: userEmail,
      reply_email: replyEmail,
      name,
      message,
      page_url: pageUrl,
      user_agent: userAgent,
    })
    .select('id, created_at')
    .single();

  if (insertError || !inserted) {
    return genericFailure();
  }

  // 7. Email — ЛУЧШЕЕ УСИЛИЕ, не влияет на ответ пользователю (п.8 ТЗ).
  //    Supabase — источник истины; если Resend недоступен, сообщение всё
  //    равно сохранено, и пользователь всё равно видит успех.
  const resendApiKey = env.RESEND_API_KEY;
  const feedbackEmail = env.FEEDBACK_EMAIL;

  if (resendApiKey && feedbackEmail) {
    const emailResult = await sendFeedbackEmail(resendApiKey, feedbackEmail, env.RESEND_FROM_EMAIL, {
      name,
      replyEmail,
      userEmail,
      message,
      pageUrl,
      userId,
      createdAt: inserted.created_at,
    });

    await admin
      .from('feedback_messages')
      .update({
        email_notification_sent: emailResult.ok,
        email_notification_error: emailResult.ok ? null : emailResult.error.slice(0, 500),
      })
      .eq('id', inserted.id);
  } else {
    await admin
      .from('feedback_messages')
      .update({
        email_notification_sent: false,
        email_notification_error: 'RESEND_API_KEY/FEEDBACK_EMAIL не настроены на сервере',
      })
      .eq('id', inserted.id);
  }

  // 8. Пользователь видит успех, если сообщение сохранено — независимо от
  //    исхода email (см. п.8 ТЗ).
  return json({ ok: true });
}
