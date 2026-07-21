/**
 * Human-language labels for the Content Registry — shared between the admin
 * UI and (optionally) any future CLI/report output. The whole point of this
 * module is Задача 12 of Этап 1.5: the owner never sees raw field names,
 * TypeScript status enums, or technical notes — only plain Russian.
 *
 * Plain ESM, no Node-specific imports.
 */

export const STATUS_LABELS = {
  published: "Опубликовано",
  draft: "Черновик",
  planned: "Запланировано",
  duplicate: "Дубль",
  merge: "Объединено",
  update: "Требует обновления",
  do_not_create: "Не создавать повторно",
};

export const QUALITY_LABELS = {
  A: "Хорошо",
  B: "Нужна доработка",
  C: "Требует серьёзной работы",
};

export const QUALITY_DESCRIPTIONS = {
  A: "Страница соответствует текущему стандарту.",
  B: "Есть конкретные недостающие блоки или другие замечания.",
  C: "Черновик, заглушка или слабая страница.",
};

export const CONTENT_TYPE_LABELS = {
  symptom: "Симптом",
  symptom_category: "Категория",
  tool: "Инструмент",
  medical_record: "Медкарта",
  assistant: "Помощник",
  about: "О проекте",
  faq: "FAQ",
  legal: "Документы",
  service: "Сервис",
  system: "Служебная",
  other: "Другое",
};

// Соответствует полям стандарта (docs/content-standard.md) и проверкам
// качества, которыми был проведён аудит Этапа 1.
const FIELD_LABELS = {
  faq: "нет FAQ",
  sources: "нет источников",
  causes: "мало возможных причин",
  whenUrgent: "нет блока «когда вызвать скорую»",
  whenToSeeDoctor: "нет блока «когда обратиться к врачу»",
  keyPoints: "нет краткого списка «Главное»",
  selfCare: "нет блока «Что делать»",
  internalLinks: "нет связанных материалов",
  shortAnswer: "слишком короткий краткий ответ",
};

/**
 * Parses the machine-oriented "Слабые места: faq, sources" note (written by
 * the Stage 1 audit script) into a friendly bullet list. Falls back to
 * returning the raw note as a single item if it doesn't match that pattern —
 * every other note in content-registry.overrides.json is already written in
 * plain Russian prose.
 */
export function humanizeNotes(notes) {
  if (!notes) return [];
  const m = notes.match(/^Слабые места:\s*(.+)$/);
  if (m) {
    return m[1]
      .split(",")
      .map((s) => s.trim())
      .map((field) => FIELD_LABELS[field] ?? field);
  }
  return [notes];
}

/**
 * @param {object} item — a ContentRegistryItem
 * @returns {{ summary: string, reasons: string[] }}
 */
export function humanizeAttentionReason(item) {
  if (item.status === "draft") {
    return {
      summary: "Черновик",
      reasons: ["Контент не готов", "Страница не должна считаться полноценным материалом"],
    };
  }
  if (item.status === "duplicate" || item.status === "merge") {
    const reasons = [];
    if (item.duplicateOf) reasons.push(`Объединена с ${item.duplicateOf}`);
    reasons.push(...humanizeNotes(item.notes).filter((n) => !n.startsWith("РЕШЕНО") && !n.startsWith("ТОЧНЫЙ ДУБЛЬ")));
    return { summary: "Объединено с другим материалом", reasons };
  }
  if (item.status === "do_not_create") {
    return { summary: "Не создавать повторно", reasons: humanizeNotes(item.notes) };
  }
  if (item.quality === "B") {
    return { summary: "Нужна доработка", reasons: humanizeNotes(item.notes) };
  }
  if (item.quality === "C") {
    return { summary: "Требует серьёзной работы", reasons: humanizeNotes(item.notes) };
  }
  return { summary: "Требует внимания", reasons: humanizeNotes(item.notes) };
}

/** Одна строка, человеческим языком — например, для описания в очереди работ. */
export function humanizeAttentionReasonText(item) {
  const { reasons } = humanizeAttentionReason(item);
  return reasons.length > 0 ? reasons.join("; ") : "Требует внимания.";
}

/** Заменяет технический duplicateOf/статус на человеческую фразу для карточки материала. */
export function humanizeRelationNote(item, resolveTitle) {
  if (!item.duplicateOf) return null;
  const targetTitle = resolveTitle(item.duplicateOf) ?? item.duplicateOf;
  if (item.status === "merge") return `Эта тема объединена с «${targetTitle}».`;
  if (item.status === "duplicate") return `Это дубль темы «${targetTitle}».`;
  if (item.status === "do_not_create") return `Дубль темы «${targetTitle}», не создавать повторно.`;
  return `Связано с «${targetTitle}».`;
}
