// Общий код между SSR (medizin) и Worker (medizin-worker) — извлечено из
// того, что раньше было src/lib/content-editor/strategy-dedupe.ts.
//
// Только эти ДВЕ маленькие чистые функции/константы нужны ОБЕИМ сторонам:
//   - medizin-worker/src/ai/strategy-dedupe.ts (dedupeAndScoreCandidates,
//     вызывается из strategy-pipeline.ts при автосохранении контент-плана
//     после исследования AI-стратега);
//   - medizin/src/pages/api/admin/content/strategy/runs/[id]/commit.ts
//     (ручное добавление ВЫБРАННЫХ кандидатов в content_ideas — путь,
//     оставшийся рабочим только для run'ов в статусе 'ready', созданных до
//     исправления "завершения старых запусков", см. комментарий в commit.ts).
//
// Остальная логика strategy-dedupe.ts (titleSimilarity/levenshtein-дедуп,
// dedupeAndScoreCandidates, типы RawCandidate/ScoredCandidate) остаётся
// ТОЛЬКО в medizin-worker — она нужна исключительно AI-конвейеру, который
// SSR больше не исполняет.

/**
 * Сопоставление стратегии исследования → reason для content_ideas.
 * @type {Record<string, string>}
 */
export const STRATEGY_TO_REASON = {
  max_traffic: "search_demand",
  fill_gaps: "gap_in_cluster",
  strengthen_cluster: "gap_in_cluster",
  seasonal: "search_demand",
};

/**
 * P0-P3 (приоритет темы в исследовании) → high/medium/low (content_ideas.priority).
 * @param {string} p
 * @returns {"high" | "medium" | "low"}
 */
export function priorityToIdeaPriority(p) {
  if (p === "P0" || p === "P1") return "high";
  if (p === "P2") return "medium";
  return "low";
}
