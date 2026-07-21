// ТЗ "AI Platform 1.0 — Этап 1: Editorial Engine 2.0", п.5 "Ошибки" —
// "Редактор никогда не должен видеть просто Running/Failed... он должен
// видеть причину" (пример: Anthropic timeout / Worker offline / Supabase
// unavailable / Validation failed / SEO generation failed / Publishing
// failed).
//
// До этого момента (см. Паспорт редакции, раздел "Ошибки") в проекте не
// было НИКАКОЙ таксономии причин ошибок вообще — content_job_runs.error
// хранит сырой текст исключения как есть (err.message), и UI просто
// показывал первые ~120 символов этого текста без какой-либо
// интерпретации. Эта функция — чистое (без побочных эффектов, без сети)
// сопоставление уже случившегося текста ошибки с понятной русской фразой;
// она НЕ меняет то, что реально произошло, и НЕ заменяет исходный текст —
// сырой текст остаётся доступен рядом (см. EditorialApp.tsx, блок "Логи").
//
// Чисто клиентская функция (импортируется в EditorialApp.tsx, React-
// компонент) — никаких серверных зависимостей, поэтому лежит в
// src/lib/content-editor/, а не в medizin-worker, хотя используется для
// текстов, которые ПОРОДИЛ воркер.

export interface HumanizedError {
  /** Короткая понятная причина на русском — то, что видит редактор в списках. */
  summary: string;
  /** Сырой оригинальный текст (для тех, кому нужны технические детали). */
  raw: string;
}

interface ErrorPattern {
  test: RegExp;
  summary: string;
}

// Порядок важен — проверяются по очереди, первое совпадение побеждает.
const PATTERNS: ErrorPattern[] = [
  { test: /worker.*offline|no.*heartbeat|воркер.*(не отвечает|недоступен)/i, summary: "Worker недоступен (не отвечает)" },
  { test: /\btimeout\b|timed out|таймаут|deadline exceeded|ETIMEDOUT/i, summary: "Anthropic не ответил вовремя (таймаут)" },
  { test: /rate.?limit|too many requests|\b429\b|overloaded/i, summary: "Превышен лимит запросов к Anthropic (rate limit)" },
  { test: /\b5\d\d\b.*anthropic|anthropic.*\b5\d\d\b|api\.anthropic\.com.*(error|failed)/i, summary: "Anthropic временно недоступен (ошибка сервиса)" },
  { test: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network.*(error|unavailable)|no internet/i, summary: "Нет сети / внешний сервис недоступен" },
  { test: /supabase|PGRST\d+|permission denied for|JWT expired|row-level security/i, summary: "Supabase недоступен или отклонил запрос" },
  { test: /budget|cost.*limit|бюджет.*(исчерпан|превышен)|hard.?limit/i, summary: "Достигнут лимит бюджета на материал" },
  { test: /github|commit.*failed|git push|octokit|Git Data API/i, summary: "Не удалось опубликовать на GitHub" },
  { test: /medical.?review|критичн.*(проблем|замечан)/i, summary: "Медицинская проверка нашла критичные замечания" },
  { test: /seo.?review|seo.*generation/i, summary: "SEO-проверка обнаружила проблему" },
  { test: /validat/i, summary: "Ошибка валидации содержимого" },
  { test: /json.*(parse|invalid)|unexpected token/i, summary: "AI вернул ответ в неожиданном формате" },
  { test: /max.*attempt|attempts exhausted|попыт.*исчерпан/i, summary: "Исчерпан лимит попыток на этот этап" },
];

/** Сопоставляет сырой текст ошибки (content_job_runs.error / decision_reason) с понятной причиной. */
export function humanizeError(raw: string | null | undefined): HumanizedError {
  const text = (raw ?? "").trim();
  if (!text) return { summary: "Ошибка без описания", raw: text };
  for (const p of PATTERNS) {
    if (p.test.test(text)) return { summary: p.summary, raw: text };
  }
  // Ничего не подошло — не выдумываем причину, показываем начало исходного
  // текста как есть (это уже лучше, чем полностью нераспознанная ошибка,
  // но честно НЕ выдаётся за "понятную" категорию).
  return { summary: text.length > 100 ? `${text.slice(0, 100)}…` : text, raw: text };
}
