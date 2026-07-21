// Infrastructure v2 — единый способ получения серверного env. Раньше (на
// Cloudflare Pages) секреты приходили через request-time Pages Functions
// runtime binding (`locals.runtime.env`, см. .dev.vars/Dashboard Secrets).
// На Node-адаптере такого биндинга не существует — сервер это обычный
// Node-процесс, и секреты читаются напрямую из process.env (заполняется
// либо `dotenv/config` в astro.config.mjs при `astro dev`/`astro build`,
// либо scripts/deploy/run-server.mjs при запуске под PM2 на сервере — см.
// DEPLOY.md). Используется ping.ts и chat.ts одинаково — единственная
// точка чтения: если способ чтения секретов когда-нибудь снова поменяется,
// меняется только этот файл, вызывающий код (20+ мест — admin auth,
// feedback, GitHub publish, analytics) трогать не нужно.
//
// Важно: НИКОГДА не использовать import.meta.env.ANTHROPIC_API_KEY — это
// build-time механизм Vite, он инлайнит значение в статический бандл.
// Секрет обязан читаться только через process.env в момент обработки
// запроса (request-time), а не во время сборки.
//
// Параметр `locals` сохранён в сигнатуре (хотя Node-реализации он не нужен)
// намеренно — чтобы не трогать 20+ вызывающих мест, все они уже вызывают
// getRuntimeEnv(locals)/hasRuntimeBinding(locals) с Astro.locals под рукой.

export interface AssistantRuntimeEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  // PUBLIC_* тоже присутствуют в process.env (Vite их туда не прячет), но
  // эти поля не нужны серверному коду — они используются клиентом через
  // import.meta.env. Здесь не типизируем специально, чтобы не путать два
  // разных механизма.
  [key: string]: string | undefined;
}

/**
 * Достаёт серверный env единообразно. На Node это просто process.env —
 * функция-обёртка сохранена, чтобы 20+ вызывающих мест не пришлось менять
 * при очередной смене платформы (единственная точка правды).
 */
export function getRuntimeEnv(_locals: App.Locals): AssistantRuntimeEnv {
  return process.env as AssistantRuntimeEnv;
}

/**
 * На Cloudflare это проверяло, что Pages Functions вообще передал runtime
 * binding (мог быть отсутствовать при неверной конфигурации). На Node
 * process.env существует всегда — оставлено для обратной совместимости
 * вызывающего кода (ping.ts), семантика теперь тривиальна.
 */
export function hasRuntimeBinding(_locals: App.Locals): boolean {
  return true;
}

const DEFAULT_MODEL = 'claude-sonnet-5';
// Разрешаем только то, что реально может быть частью имени модели Anthropic
// (буквы/цифры/точки/дефисы). Если в ANTHROPIC_MODEL случайно попадёт что-то
// вроде "claude-sonnet-5 (default)" (например, скопировали строку из вывода
// /api/assistant/ping, а не реальное имя модели) — тихо откатываемся на
// безопасный дефолт вместо отправки заведомо невалидного имени в Anthropic API.
const SAFE_MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Единая точка выбора имени модели — используется и в ping.ts, и в chat.ts. */
export function resolveModel(rawValue: string | undefined): string {
  const trimmed = rawValue?.trim();
  if (!trimmed) return DEFAULT_MODEL;
  return SAFE_MODEL_PATTERN.test(trimmed) ? trimmed : DEFAULT_MODEL;
}

// ТЗ "автономное производство статей и снижение стоимости", п.12: "более
// дешёвую модель для... короткой финальной проверки". Вызов 4
// (stages/final-review.ts) — классификационная задача над несколькими уже
// написанными фрагментами, не полноценный медицинский ресёрч, поэтому не
// требует той же модели, что исследование/медпроверка. Если
// ANTHROPIC_MODEL_FAST не задан в окружении — тихо используем ту же модель,
// что и остальной конвейер (resolveModel), чтобы ничего не сломать там, где
// второй ключ/модель не настроены.
const DEFAULT_FAST_MODEL = "claude-haiku-4-5-20251001";

export function resolveFastModel(rawValue: string | undefined, fallbackModel: string): string {
  const trimmed = rawValue?.trim();
  if (!trimmed) return SAFE_MODEL_PATTERN.test(DEFAULT_FAST_MODEL) ? DEFAULT_FAST_MODEL : fallbackModel;
  return SAFE_MODEL_PATTERN.test(trimmed) ? trimmed : fallbackModel;
}
