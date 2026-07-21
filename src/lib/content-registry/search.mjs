/**
 * Shared Content Registry SEARCH logic — the ONE implementation used both by
 * the CLI (`npm run content:find`, via scripts/content-find.mjs) and by the
 * admin UI (`/admin/content`, via ContentDashboard.tsx, running client-side
 * in the browser on the JSON already fetched from /api/admin/content/registry).
 *
 * Plain ESM, zero Node-specific imports (no `fs`/`path`) — so this file can be
 * imported unmodified from a Node CLI script AND bundled into a browser
 * client component by Vite. Do not add `node:*` imports here.
 *
 * This is deliberately framework-agnostic: it takes a plain array of registry
 * items and a query string, and returns structured data. Each caller (CLI vs
 * React) is responsible for its own presentation/formatting — but the actual
 * matching algorithm (tokenize/levenshtein/scoring/exact vs retired vs
 * similar) must never be re-implemented a second time.
 */

const STOP = new Set(["в", "на", "с", "из", "и", "у", "от", "за", "при", "без", "до", "после", "во", "к", "о", "об"]);

export function tokenize(s) {
  return (String(s).toLowerCase().match(/[а-яёa-z]+/g) || []).filter((w) => !STOP.has(w) && w.length > 2);
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-zа-яё0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

export function similarity(a, b) {
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length, 1);
}

function itemTags(item) {
  return item.tags ?? item._raw?.data?.tags ?? [];
}

/**
 * @param {Array<object>} items  full registry (live + retired), as returned by
 *   getContentRegistry() (Astro side) or buildRegistry().items (Node CLI side)
 * @param {string} query
 * @returns {{
 *   query: string,
 *   exactLive: object[],
 *   exactRetired: object[],
 *   similar: Array<{item: object, score: number, sharedTokens: string[], tagOverlap: string[], titleSim: number}>,
 *   recommendation: 'exists' | 'retired' | 'check_similar' | 'safe_with_related' | 'safe'
 * }}
 */
export function searchRegistry(items, query) {
  const queryNorm = String(query).toLowerCase().trim();
  const queryTokens = new Set(tokenize(query));
  const querySlug = slugify(query);

  const exact = items.filter((i) => i.title?.toLowerCase().trim() === queryNorm || i.slug === querySlug);
  const seen = new Set(exact.map((i) => i.id));

  const similar = items
    .filter((i) => !seen.has(i.id))
    .map((i) => {
      const titleSim = similarity(queryNorm, (i.title ?? "").toLowerCase().trim());
      const tokens = tokenize(i.title ?? "");
      const sharedTokens = tokens.filter((t) => queryTokens.has(t));
      const tagOverlap = itemTags(i).filter((t) => queryTokens.has(String(t).toLowerCase()));
      const score = Math.max(
        titleSim,
        sharedTokens.length > 0 ? 0.6 + 0.1 * sharedTokens.length : 0,
        tagOverlap.length > 0 ? 0.55 : 0
      );
      return { item: i, score, sharedTokens, tagOverlap, titleSim };
    })
    .filter((r) => r.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const exactRetired = exact.filter((i) => i.retired);
  const exactLive = exact.filter((i) => !i.retired);

  let recommendation;
  if (exactLive.length > 0) recommendation = "exists";
  else if (exactRetired.length > 0) recommendation = "retired";
  else if (similar.some((r) => r.score >= 0.75)) recommendation = "check_similar";
  else if (similar.length > 0) recommendation = "safe_with_related";
  else recommendation = "safe";

  return { query, exactLive, exactRetired, similar, recommendation };
}
