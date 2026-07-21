/**
 * The ONLY hand-maintained backlog list in the project — and it is
 * deliberately tiny. It exists purely for technical/process items that are
 * NOT tied to a single Content Registry entry (so they can't be derived from
 * `content-registry.overrides.json` the way P1 is — see
 * src/lib/content-registry/queue.mjs).
 *
 * Anything that CAN be derived from the Registry (quality B/C, draft status,
 * duplicates) MUST be derived, not listed here — see queue.mjs. This file is
 * the single source of truth for the handful of items that can't be; do not
 * maintain a second copy of this list anywhere (docs/content-audit/CONTENT_BACKLOG.md
 * is regenerated FROM this file + the live registry via
 * `npm run content:backlog`, see scripts/generate-content-backlog-md.mjs).
 *
 * Plain ESM, no Node-specific imports — importable from CLI scripts and from
 * the admin UI bundle alike.
 */
export const technicalBacklog = {
  p0: [
    // Both P0 items found in the Stage 1 audit (siteConfig.url placeholder,
    // blurred-vision duplicate stub) were resolved on 2026-07-09 — see
    // content-registry.retired.json and CONTENT_AUDIT.md for history.
    // Currently empty. Add here only genuinely urgent, non-content-registry
    // technical issues (broken build, critical infra bug).
  ],
  p2: [
    {
      id: "TECH-001",
      title: "Заменить плейсхолдеры OpenGraph/Twitter",
      description:
        "siteConfig.twitterHandle (@medizin) и siteConfig.defaultOgImage (/og-default.png) в src/config/site.ts — плейсхолдеры, нужно заменить на реальные значения перед публикацией.",
    },
    // TECH-002 (исключить служебные страницы из sitemap) решён в SEO/Контент,
    // Этап 2, 2026-07-09 — astro.config.mjs теперь передаёт filter в sitemap().
    {
      id: "TECH-003",
      title: "Проставить связи между смежными темами",
      description:
        "14 пар из docs/content-audit/overlaps.md (parent/child и related) учтены в content-registry.overrides.json (relatedContentIds), но не все отражены как manualRelated в самих .mdx-файлах симптомов — стоит проставить перелинковку в самом контенте.",
    },
  ],
  p3: [
    // Новый контент — сознательно пусто на этом этапе.
  ],
};
