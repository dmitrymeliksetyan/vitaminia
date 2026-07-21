// Отправка email через Resend обычным fetch — без добавления SDK-зависимости
// (ТЗ явно предпочитает это: "не устанавливать Resend SDK... через fetch").
//
// Вызывается ТОЛЬКО из src/pages/api/feedback.ts, ПОСЛЕ успешного сохранения
// сообщения в Supabase (см. п.8 ТЗ "логика надёжности" — email никогда не
// является условием успеха для пользователя).

const RESEND_TIMEOUT_MS = 10_000;
const DEFAULT_FROM = 'MEDIZIN.RU <onboarding@resend.dev>'; // безопасный дефолт до подтверждения домена medizin.ru

export interface FeedbackEmailPayload {
  name: string | null;
  replyEmail: string | null;
  userEmail: string | null;
  message: string;
  pageUrl: string | null;
  userId: string | null;
  createdAt: string;
}

export type SendEmailResult = { ok: true } | { ok: false; error: string };

function buildPlainTextBody(payload: FeedbackEmailPayload): string {
  const lines = [
    payload.name ? `Имя: ${payload.name}` : null,
    payload.replyEmail ? `Email для ответа: ${payload.replyEmail}` : null,
    payload.userEmail ? `Email аккаунта: ${payload.userEmail}` : null,
    '',
    'Сообщение:',
    payload.message,
    '',
    payload.pageUrl ? `Страница: ${payload.pageUrl}` : null,
    `Дата: ${payload.createdAt}`,
    payload.userId ? `user_id: ${payload.userId}` : null,
  ].filter((l) => l !== null);
  return lines.join('\n');
}

/**
 * Отправляет email-уведомление владельцу сайта. Никогда не бросает
 * исключение — любой исход возвращается как обычное значение, чтобы вызывающий
 * код (feedback.ts) мог записать короткое безопасное описание ошибки в
 * email_notification_error и всё равно вернуть пользователю успех (сообщение
 * уже сохранено в Supabase к моменту вызова этой функции).
 */
export async function sendFeedbackEmail(
  apiKey: string,
  toEmail: string,
  fromEmail: string | undefined,
  payload: FeedbackEmailPayload,
): Promise<SendEmailResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail || DEFAULT_FROM,
        to: [toEmail],
        subject: 'MEDIZIN.RU — новое сообщение',
        text: buildPlainTextBody(payload),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      // Короткое и безопасное — это уходит в email_notification_error
      // (техническая колонка в БД, не показывается пользователю).
      return { ok: false, error: `Resend HTTP ${response.status}: ${errText.slice(0, 200)}` };
    }

    return { ok: true };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? 'Resend timeout' : `Resend error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
