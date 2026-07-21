/**
 * Форк validate.mjs из medizin-shared, упрощён под единственный тип
 * контента Vitaminia (nutrient) — единая реализация для CLI
 * (`npm run content:check`) и админки (кнопка «Проверить контент»).
 *
 * Plain ESM, zero Node-specific imports — см. search.mjs.
 */
import { levenshtein } from "./search.mjs";
import { buildLinkGraph, collectBrokenLinks } from "./links.mjs";

function normalizeTitle(t) {
  return (t || "").toLowerCase().trim();
}

const TITLE_MIN = 10;
const TITLE_MAX = 70;
const DESC_MIN = 50;
const DESC_MAX = 160;

/**
 * @param {Array<object>} items — full registry (live + retired)
 * @param {string[]} parseProblems — structural problems already found while
 *   reading the source files (slug/category mismatches, missing IDs, etc.) —
 *   only the Node CLI path has these (from buildRegistry().problems); the
 *   browser/Astro path can pass an empty array.
 * @returns {{ criticalErrors: {level:'error', msg:string}[], warnings: {level:'warning', msg:string}[], totalItems: number }}
 */
export function validateRegistry(items, parseProblems = []) {
  const criticalErrors = parseProblems.map((p) => ({ level: "error", msg: p }));
  const warnings = [];

  // --- duplicate IDs ---
  const byId = new Map();
  for (const item of items) {
    if (byId.has(item.id)) {
      criticalErrors.push({
        level: "error",
        msg: `Duplicate ID "${item.id}": ${byId.get(item.id).source} and ${item.source}`,
      });
    } else {
      byId.set(item.id, item);
    }
  }

  // --- duplicate URLs ---
  const byUrl = new Map();
  for (const item of items) {
    if (byUrl.has(item.url)) {
      const other = byUrl.get(item.url);
      criticalErrors.push({
        level: "error",
        msg: `Duplicate URL detected\n${item.url}\n${other.id}: ${other.title}\n${item.id}: ${item.title}`,
      });
    } else {
      byUrl.set(item.url, item);
    }
  }

  // --- duplicate slugs (within same contentType) ---
  const bySlug = new Map();
  for (const item of items) {
    const key = `${item.contentType}::${item.slug}`;
    if (bySlug.has(key)) {
      criticalErrors.push({
        level: "error",
        msg: `Duplicate slug "${item.slug}" within ${item.contentType}: ${bySlug.get(key).id} and ${item.id}`,
      });
    } else {
      bySlug.set(key, item);
    }
  }

  // --- duplicate titles (exact match, same contentType) — warning unless already flagged ---
  const byTitle = new Map();
  for (const item of items) {
    if (item.contentType !== "nutrient") continue;
    const key = normalizeTitle(item.title);
    if (byTitle.has(key)) {
      const other = byTitle.get(key);
      const bothHandled =
        ["duplicate", "merge", "do_not_create"].includes(item.status) ||
        ["duplicate", "merge", "do_not_create"].includes(other.status);
      const msg = `Duplicate title "${item.title}": ${other.id} (${other.url}) and ${item.id} (${item.url})`;
      if (bothHandled) {
        warnings.push({ level: "warning", msg: msg + " — already flagged as duplicate/merge, OK for now." });
      } else {
        criticalErrors.push({ level: "error", msg: msg + " — neither is marked status:duplicate/merge!" });
      }
    } else {
      byTitle.set(key, item);
    }
  }

  // --- required fields ---
  const REQUIRED = ["id", "title", "slug", "url", "contentType", "status", "source"];
  for (const item of items) {
    for (const field of REQUIRED) {
      if (item[field] === undefined || item[field] === null || item[field] === "") {
        criticalErrors.push({ level: "error", msg: `Missing required field "${field}" on ${item.id ?? item.url}` });
      }
    }
  }

  // --- broken duplicateOf / parentContentId / relatedContentIds references ---
  for (const item of items) {
    for (const field of ["duplicateOf", "parentContentId"]) {
      if (item[field] && !byId.has(item[field])) {
        criticalErrors.push({
          level: "error",
          msg: `${item.id} has ${field}="${item[field]}" which does not exist in the registry`,
        });
      }
    }
    for (const rel of item.relatedContentIds ?? []) {
      if (!byId.has(rel)) {
        criticalErrors.push({
          level: "error",
          msg: `${item.id} has relatedContentIds entry "${rel}" which does not exist in the registry`,
        });
      }
    }
  }

  // --- status:duplicate must carry duplicateOf ---
  for (const item of items) {
    if (item.status === "duplicate" && !item.duplicateOf) {
      criticalErrors.push({ level: "error", msg: `${item.id} has status:duplicate but no duplicateOf reference` });
    }
  }

  // --- suspiciously similar titles (fuzzy, cross-item, informational only) ---
  const nutrientItems = items.filter((i) => i.contentType === "nutrient" && !i.retired);
  for (let i = 0; i < nutrientItems.length; i++) {
    for (let j = i + 1; j < nutrientItems.length; j++) {
      const a = nutrientItems[i];
      const b = nutrientItems[j];
      if (normalizeTitle(a.title) === normalizeTitle(b.title)) continue; // already handled above
      const dist = levenshtein(normalizeTitle(a.title), normalizeTitle(b.title));
      const maxLen = Math.max(a.title.length, b.title.length);
      const sim = 1 - dist / maxLen;
      if (sim > 0.82) {
        warnings.push({
          level: "warning",
          msg: `Suspiciously similar titles (${(sim * 100).toFixed(0)}%): ${a.id} "${a.title}" vs ${b.id} "${b.title}" — review before creating anything similar.`,
        });
      }
    }
  }

  // --- техническая целостность и связи ---
  // Единая точка: и `npm run content:check`, и admin UI получают эти
  // критические/предупреждения отсюда же, второй раз граф не считается
  // (см. seo-health.mjs — он переиспользует именно этот вызов через
  // computeContentHealth(), а не пересчитывает links.mjs заново).
  const linkGraph = buildLinkGraph(items);
  const broken = collectBrokenLinks(linkGraph);
  for (const b of broken) {
    if (b.reason === "not_found") {
      criticalErrors.push({ level: "error", msg: `${b.id}: битая внутренняя ссылка на несуществующую страницу (${b.href})` });
    } else if (b.reason === "retired_no_redirect") {
      criticalErrors.push({ level: "error", msg: `${b.id}: ссылка на удалённый/объединённый материал без редиректа (${b.href})` });
    } else if (b.reason === "draft") {
      warnings.push({ level: "warning", msg: `${b.id}: ссылка на черновик (${b.href}) — не должна быть видна как самостоятельный материал` });
    }
  }

  const liveNutrientsForHealth = items.filter((i) => i.contentType === "nutrient" && !i.retired && i.status !== "draft");
  for (const s of liveNutrientsForHealth) {
    const node = linkGraph.byId.get(s.id);
    if (node && node.incomingCount === 0) {
      warnings.push({ level: "warning", msg: `${s.id} "${s.title}": страница-сирота — нет входящих внутренних ссылок` });
    }
    if (node && node.outgoingCount === 0) {
      warnings.push({ level: "warning", msg: `${s.id} "${s.title}": нет исходящих тематических ссылок на связанные материалы` });
    }
    if (!s.titleTag) {
      criticalErrors.push({ level: "error", msg: `${s.id} "${s.title}": нет title` });
    } else if (s.titleTag.length < TITLE_MIN || s.titleTag.length > TITLE_MAX) {
      warnings.push({ level: "warning", msg: `${s.id} "${s.title}": title нестандартной длины (${s.titleTag.length} симв.)` });
    }
    if (!s.metaDescription) {
      criticalErrors.push({ level: "error", msg: `${s.id} "${s.title}": нет description` });
    } else if (s.metaDescription.length < DESC_MIN || s.metaDescription.length > DESC_MAX) {
      warnings.push({ level: "warning", msg: `${s.id} "${s.title}": description нестандартной длины (${s.metaDescription.length} симв.)` });
    }
  }

  return { criticalErrors, warnings, totalItems: items.length, linkGraph };
}
