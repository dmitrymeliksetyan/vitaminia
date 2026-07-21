// ЭТАП 1 аналитики — явный whitelist событий и допустимых полей metadata.
//
// КРИТИЧЕСКИ ВАЖНО: это единственное место, которое решает, что вообще
// может попасть в analytics_events. Ничего, кроме перечисленного здесь, не
// проходит — ни новое имя события, ни лишнее поле в metadata. Список полей
// сознательно PER-EVENT (whitelist полей, а не blacklist запрещённых имён),
// потому что запрещать по чёрному списку ("email", "message", "text"...)
// ненадёжно — всегда можно придумать новое поле с медицинским содержанием
// под неочевидным именем. Разрешаем только то, что явно перечислено.

export type AnalyticsEventName =
  | 'page_view'
  | 'signup_started'
  | 'signup_completed'
  | 'card_opened'
  | 'card_section_started'
  | 'card_section_completed'
  | 'assistant_opened'
  | 'assistant_first_message'
  | 'assistant_card_enabled'
  | 'journal_created'
  | 'journal_entry_added';

type FieldType = 'string' | 'boolean';

interface FieldRule {
  type: FieldType;
  maxLength?: number; // только для string
  allowedValues?: readonly string[]; // если задано — ограничивает набор значений
}

// Разрешённые поля metadata для каждого события. Пустой объект = metadata
// для этого события не используется вообще (лишние поля будут отброшены).
const EVENT_METADATA_SCHEMA: Record<AnalyticsEventName, Record<string, FieldRule>> = {
  page_view: {
    content_type: {
      type: 'string',
      allowedValues: ['home', 'symptom_category', 'symptom', 'how_it_works', 'my_card', 'assistant'],
    },
    slug: { type: 'string', maxLength: 100 },
  },
  signup_started: {},
  signup_completed: {},
  card_opened: {},
  card_section_started: { section: { type: 'string', maxLength: 60 } },
  card_section_completed: { section: { type: 'string', maxLength: 60 } },
  assistant_opened: {},
  assistant_first_message: {},
  assistant_card_enabled: { enabled: { type: 'boolean' } },
  journal_created: {},
  journal_entry_added: {},
};

export const ANALYTICS_EVENT_NAMES = Object.keys(EVENT_METADATA_SCHEMA) as AnalyticsEventName[];

const MAX_METADATA_JSON_SIZE = 1000; // символов после сериализации — с запасом от лимита БД (2000 байт)
const MAX_PAGE_PATH_LENGTH = 512;

export function isKnownEvent(name: unknown): name is AnalyticsEventName {
  return typeof name === 'string' && (ANALYTICS_EVENT_NAMES as string[]).includes(name);
}

/**
 * Отфильтровывает metadata до только разрешённых для этого события полей,
 * с проверкой типа/длины/допустимых значений. Всё остальное — молча
 * отбрасывается (не ошибка запроса, просто не сохраняется), чтобы
 * случайно лишнее поле от клиента не роняло событие целиком.
 */
export function sanitizeMetadata(
  eventName: AnalyticsEventName,
  raw: unknown,
): Record<string, string | boolean> {
  const schema = EVENT_METADATA_SCHEMA[eventName];
  const result: Record<string, string | boolean> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;

  for (const [key, rule] of Object.entries(schema)) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;

    if (rule.type === 'boolean') {
      if (typeof value === 'boolean') result[key] = value;
      continue;
    }

    if (rule.type === 'string') {
      if (typeof value !== 'string') continue;
      const v = value.slice(0, rule.maxLength ?? 100);
      if (rule.allowedValues && !(rule.allowedValues as readonly string[]).includes(v)) continue;
      result[key] = v;
    }
  }

  // Финальная страховка по общему размеру — даже если все поля по
  // отдельности прошли, сумма не должна раздуваться.
  if (JSON.stringify(result).length > MAX_METADATA_JSON_SIZE) return {};

  return result;
}

/** Обрезает query-параметры/hash и ограничивает длину — см. п. "page_path" ТЗ. */
export function sanitizePagePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const path = raw.startsWith('http') ? new URL(raw).pathname : raw.split('?')[0].split('#')[0];
    return path.slice(0, MAX_PAGE_PATH_LENGTH);
  } catch {
    return null;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeId(raw: unknown): string | null {
  return typeof raw === 'string' && UUID_PATTERN.test(raw) ? raw : null;
}
