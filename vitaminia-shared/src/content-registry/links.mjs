/**
 * Форк links.mjs из medizin-shared, упрощён под единственный тип контента
 * Vitaminia (nutrient) — карта внутренних связей между живыми нутриентами.
 * Единая реализация для CLI и админки, как и остальные .mjs в этой папке,
 * без node:*.
 *
 * ВАЖНО: это НЕ вторая копия правил перелинковки. Список "исходящих" ссылок
 * страницы намеренно построен ТЕМ ЖЕ приоритетом, что и реальный публичный
 * блок «Nutrientes relacionados» (см. getRelatedNutrients в
 * vitaminia-live/src/config/content.ts):
 *   1. manualRelated (явные связи редактора);
 *   2. пересечение тегов (тематическая близость);
 *   3. та же категория (фолбэк, если материалов меньше RELATED_MIN).
 * Обе реализации читают одни и те же поля (tags/manualRelated/category) из
 * одного и того же Registry — поэтому граф здесь описывает именно то, что
 * реально отрендерится на живой странице, а не абстрактную догадку.
 *
 * Дополнительно граф учитывает markdown-ссылки внутри самого текста MDX
 * (`_raw.body`, доступно только на Node-стороне через content-registry-lib.mjs)
 * — на случай, если автор вручную сослался на другой нутриент прямо в
 * тексте, а не только через manualRelated. В отличие от medizin (где все
 * внутренние ссылки имеют общий префикс /symptoms/), у Vitaminia URL —
 * `/{category}/{slug}` без общего префикса, поэтому здесь просто
 * проверяются все относительные ссылки, начинающиеся с "/", через прямое
 * совпадение с известным Registry URL.
 */

const RELATED_MIN = 3;
const RELATED_MAX = 6;

function isLive(item) {
  return item.contentType === "nutrient" && !item.retired && item.status !== "draft";
}

/** Тот же приоритет, что getRelatedNutrients() — см. заголовок файла. */
function computeOutgoing(item, liveNutrients) {
  const manual = (item.manualRelated ?? [])
    .map((slug) => liveNutrients.find((s) => s.slug === slug))
    .filter((s) => s && s.id !== item.id);

  const picked = new Set(manual.map((s) => s.id));
  picked.add(item.id);
  const tags = new Set(item.tags ?? []);

  const byTagOverlap = liveNutrients
    .filter((s) => !picked.has(s.id))
    .map((s) => ({ item: s, overlap: (s.tags ?? []).filter((t) => tags.has(t)).length }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .map((x) => x.item);

  let result = [...manual, ...byTagOverlap];
  for (const s of byTagOverlap) picked.add(s.id);

  if (result.length < RELATED_MIN) {
    const sameCategory = liveNutrients.filter((s) => !picked.has(s.id) && s.category === item.category);
    result = [...result, ...sameCategory];
  }

  return result.slice(0, RELATED_MAX).map((s) => s.id);
}

/** Ссылки-markdown `](/...)` внутри тела MDX (Node CLI-сторона, где есть `_raw.body`) — только относительные внутренние. */
function extractBodyLinks(body) {
  if (!body) return [];
  const out = [];
  const re = /\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(body))) {
    const href = m[1];
    if (href.startsWith("/") && !href.startsWith("//")) out.push(href.replace(/\/$/, ""));
  }
  return out;
}

/**
 * @param {Array<object>} items — полный Registry (живые + retired)
 * @returns {{
 *   byId: Map<string, {
 *     outgoingIds: string[],
 *     incomingIds: string[],
 *     outgoingCount: number,
 *     incomingCount: number,
 *     brokenOutgoing: Array<{href:string, reason:'not_found'|'retired_no_redirect'|'draft'}>,
 *     bodyLinkIds: string[],
 *   }>,
 *   orphanIds: string[],
 * }}
 */
export function buildLinkGraph(items) {
  const liveNutrients = items.filter(isLive);
  const byUrl = new Map(items.map((i) => [i.url.replace(/\/$/, ""), i]));

  const byId = new Map();
  for (const s of liveNutrients) {
    byId.set(s.id, {
      outgoingIds: [],
      incomingIds: [],
      outgoingCount: 0,
      incomingCount: 0,
      brokenOutgoing: [],
      bodyLinkIds: [],
    });
  }

  // Исходящие через приоритет "Nutrientes relacionados" (manualRelated → теги → категория)
  for (const s of liveNutrients) {
    const outgoingIds = computeOutgoing(s, liveNutrients);
    byId.get(s.id).outgoingIds = outgoingIds;
    byId.get(s.id).outgoingCount = outgoingIds.length;
  }

  // Входящие — просто инверсия исходящих (те же связи, что реально рендерятся)
  for (const s of liveNutrients) {
    for (const targetId of byId.get(s.id).outgoingIds) {
      const target = byId.get(targetId);
      if (target && !target.incomingIds.includes(s.id)) {
        target.incomingIds.push(s.id);
      }
    }
  }

  // Ручные ссылки внутри текста MDX — только если данные пришли из Node CLI
  // (buildRegistry() кладёт _raw.body); проверяем на битые/retired-ссылки.
  for (const s of liveNutrients) {
    const body = s._raw?.body;
    if (!body) continue;
    const hrefs = extractBodyLinks(body);
    const node = byId.get(s.id);
    for (const href of hrefs) {
      const clean = href.replace(/\/$/, "").split("#")[0].split("?")[0];
      const target = byUrl.get(clean);
      if (!target) {
        node.brokenOutgoing.push({ href, reason: "not_found" });
        continue;
      }
      if (target.retired) {
        node.brokenOutgoing.push({ href, reason: target.redirect ? "retired_has_redirect" : "retired_no_redirect" });
        continue;
      }
      if (target.status === "draft") {
        node.brokenOutgoing.push({ href, reason: "draft" });
        continue;
      }
      if (!node.bodyLinkIds.includes(target.id)) node.bodyLinkIds.push(target.id);
    }
  }

  for (const [id, node] of byId) {
    node.incomingCount = node.incomingIds.length;
  }

  const orphanIds = liveNutrients.filter((s) => byId.get(s.id).incomingCount === 0).map((s) => s.id);

  return { byId, orphanIds };
}

/** Реальные (не retired-not-yet-redirected) "битые" ссылки — для content:check critical. */
export function collectBrokenLinks(linkGraph) {
  const broken = [];
  for (const [id, node] of linkGraph.byId) {
    for (const b of node.brokenOutgoing) {
      if (b.reason === "not_found" || b.reason === "retired_no_redirect" || b.reason === "draft") {
        broken.push({ id, ...b });
      }
    }
  }
  return broken;
}
