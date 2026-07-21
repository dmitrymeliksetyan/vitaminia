/**
 * Форк seo-health.mjs из medizin-shared, упрощён под единственный тип
 * контента Vitaminia (nutrient) — «Здоровье контента»: конкретные
 * технические проверки на каждую живую страницу.
 *
 * Осознанно НЕ проверяет "качество текста" — длина текста/число слов/
 * заголовков сюда не входит вообще. Редакторское качество (A/B/C, quality
 * field) — отдельная, уже существующая система (Content Registry
 * overrides), эта функция её не трогает и не подменяет, только читает как
 * отдельное поле для отображения рядом.
 *
 * Использует buildLinkGraph() (links.mjs) и validateRegistry() (validate.mjs)
 * — не пересчитывает дубли/битые ссылки второй раз, только читает их вывод.
 *
 * Plain ESM, без node:*.
 */
import { validateRegistry } from "./validate.mjs";

const TITLE_MIN = 10;
const TITLE_MAX = 70;
const DESC_MIN = 50;
const DESC_MAX = 160;
const RELATED_WEAK_THRESHOLD = 2; // меньше этого — "мало связанных материалов"

// Категории (nutrient_category) явно исключены из проверяемой области — эта
// функция считает состояние только реальных материалов-нутриентов, не
// контейнеров-категорий.
function isCheckable(item) {
  return !item.retired && item.status !== "draft" && item.contentType === "nutrient";
}

/**
 * @param {Array<object>} items — полный Registry (живые + retired)
 * @returns {{
 *   byId: Map<string, { status: 'good'|'warning'|'critical', criticalIssues: string[], warnings: string[], incomingCount: number, outgoingCount: number }>,
 *   linkGraph: ReturnType<typeof buildLinkGraph>,
 *   validation: ReturnType<typeof validateRegistry>,
 *   summary: { good: number, warning: number, critical: number, orphans: number, brokenLinks: number },
 * }}
 */
export function computeContentHealth(items, parseProblems = []) {
  const validation = validateRegistry(items, parseProblems);
  const linkGraph = validation.linkGraph;

  // Дубли по конкретному ID — чтобы карточка материала могла показать "нет похожего материала" честно.
  const similarByItemId = new Map();
  for (const w of validation.warnings) {
    const m = w.msg.match(/^Suspiciously similar titles \(\d+%\): (NUT-\d+) .* vs (NUT-\d+) /);
    if (m) {
      const [, a, b] = m;
      if (!similarByItemId.has(a)) similarByItemId.set(a, []);
      if (!similarByItemId.has(b)) similarByItemId.set(b, []);
      similarByItemId.get(a).push(b);
      similarByItemId.get(b).push(a);
    }
  }

  const byId = new Map();
  const summary = { good: 0, warning: 0, critical: 0, orphans: 0, brokenLinks: 0 };

  for (const item of items) {
    if (!isCheckable(item)) continue;

    const criticalIssues = [];
    const warnings = [];
    const node = linkGraph.byId.get(item.id);
    const incomingCount = node?.incomingCount ?? null;
    const outgoingCount = node?.outgoingCount ?? null;

    // --- метаданные ---
    if (!item.titleTag) criticalIssues.push("Нет title");
    else if (item.titleTag.length < TITLE_MIN) warnings.push(`Title слишком короткий (${item.titleTag.length} симв.)`);
    else if (item.titleTag.length > TITLE_MAX) warnings.push(`Title слишком длинный (${item.titleTag.length} симв.)`);

    if (!item.metaDescription) criticalIssues.push("Нет description");
    else if (item.metaDescription.length < DESC_MIN) warnings.push(`Description слишком короткий (${item.metaDescription.length} симв.)`);
    else if (item.metaDescription.length > DESC_MAX) warnings.push(`Description слишком длинный (${item.metaDescription.length} симв.)`);

    if (!item.h1) criticalIssues.push("Нет H1");

    if (!item.canonical) criticalIssues.push("Нет canonical");

    if (item.inSitemap === false) warnings.push("Исключена из sitemap");

    // --- структура (в этом проекте Breadcrumbs/JSON-LD рендерятся общим
    // шаблоном страницы всегда — если элемент вообще "живой", у него они
    // есть; проверка здесь фиксирует факт для карточки, а не гадает) ---
    const hasBreadcrumbs = true;
    const hasStructuredData = true;

    // --- связи ---
    if (incomingCount === 0) {
      warnings.push("Нет входящих внутренних ссылок");
      summary.orphans += 1;
    }
    if (outgoingCount === 0) {
      warnings.push("Нет исходящих тематических ссылок");
    } else if (outgoingCount < RELATED_WEAK_THRESHOLD) {
      warnings.push(`Только ${outgoingCount} связанный материал`);
    }
    if (node?.brokenOutgoing?.length) {
      for (const b of node.brokenOutgoing) {
        if (b.reason === "not_found") {
          criticalIssues.push(`Битая внутренняя ссылка: ${b.href}`);
          summary.brokenLinks += 1;
        } else if (b.reason === "retired_no_redirect") {
          criticalIssues.push(`Ссылка на удалённый материал без редиректа: ${b.href}`);
          summary.brokenLinks += 1;
        } else if (b.reason === "draft") {
          warnings.push(`Ссылка на черновик: ${b.href}`);
        }
      }
    }

    // --- дубли (переиспользуем validateRegistry(), не пересчитываем) ---
    const similarIds = similarByItemId.get(item.id) ?? [];
    if (similarIds.length > 0) {
      warnings.push(`Похожий материал уже есть: ${similarIds.join(", ")}`);
    }

    // Отсутствие источников не блокирует публикацию, но остаётся видимым
    // замечанием качества — "Не указаны источники" (некритическое, не
    // попадает в criticalIssues, не переводит status в 'critical').
    if (!Array.isArray(item.sources) || item.sources.length === 0) {
      warnings.push("Не указаны источники");
    }

    const status = criticalIssues.length > 0 ? "critical" : warnings.length > 0 ? "warning" : "good";
    summary[status] += 1;

    byId.set(item.id, {
      status,
      criticalIssues,
      warnings,
      incomingCount,
      outgoingCount,
      hasBreadcrumbs,
      hasStructuredData,
    });
  }

  return { byId, linkGraph, validation, summary };
}

export const SEO_STATUS_LABELS = {
  good: "Хорошо",
  warning: "Есть замечания",
  critical: "Критическая проблема",
};
