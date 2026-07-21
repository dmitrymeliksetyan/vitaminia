// Infrastructure v2 — грузим .env в process.env ДО всего остального в этом
// файле. Раньше секреты (ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY,
// GITHUB_TOKEN и т.п.) приходили через Cloudflare Pages Functions runtime
// binding (`.dev.vars` локально, Dashboard Secrets на проде) — при переходе
// на Node-адаптер этого механизма больше нет, обычный Node процесс читает
// секреты из process.env. `dotenv/config` — единая точка, работающая
// одинаково в `astro dev`, `astro build` и на сервере (см.
// scripts/deploy/run-server.mjs, который делает то же самое для
// production-процесса под PM2). PUBLIC_*-переменные (для клиентского
// бандла) по-прежнему проходят отдельным механизмом Vite/import.meta.env —
// dotenv здесь их не подменяет, а лишь даёт то же значение и серверному
// process.env.
import "dotenv/config";

import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";
import react from "@astrojs/react";
import node from "@astrojs/node";
import { siteConfig } from "./src/config/site.ts";

// ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ: в `npm run dev` маршрут `/` возвращает 500 из-за бага
// @astrojs/react@6.0.1 + Astro 4.15.0. Баг: React устанавливает jsx:'automatic'
// глобально через config.esbuild, что конфликтует с Astro compile.js на root-route.
// `npm run build` и `npm run preview` работают без ошибок.
// Все остальные маршруты (/my, /auth/*, /hangover, /symptoms/*) работают в dev.
//
// Infrastructure v2 ("переезд с Cloudflare Pages на собственный сервер") —
// адаптер сменён с @astrojs/cloudflare на @astrojs/node (standalone). Сам
// принцип разделения статики/SSR НЕ меняется: output: 'hybrid' — весь
// существующий сайт остаётся статическим (prerender по умолчанию = true),
// динамическими остаются только страницы/роуты, которые явно объявляют
// `export const prerender = false;` (/api/**, часть /admin/**) — это ровно
// тот же список, что и раньше, ни одна existing страница не меняет
// поведение рендеринга при смене адаптера.
//
// `mode: "standalone"` — Node-адаптер сам поднимает HTTP-сервер (без
// дополнительного middleware/Express), именно он собирается в
// dist/server/entry.mjs и именно его запускает PM2 (см.
// scripts/deploy/run-server.mjs, ecosystem.config.cjs). nginx проксирует на
// него только динамические префиксы (/assistant, /my, /admin, /api) — см.
// nginx/medizin.conf; все статические страницы nginx отдаёт напрямую из
// dist/client, минуя Node (см. DEPLOY.md, п. "Архитектура").
//
// SEO/Контент, Этап 2 (п.2/п.18–19 ТЗ) — @astrojs/sitemap без фильтра включал
// в sitemap-index.xml все статически собранные страницы, включая закрытые
// разделы (/admin, /admin/content, /admin/feedback, /admin/users, /my,
// /auth/*, /assistant-test) — они уже отдают <meta name="robots" content="noindex">
// через AppLayout.astro, но noindex сам по себе не мешает попаданию в sitemap
// (это разные механизмы, см. п.19 ТЗ — "не полагаться только на robots.txt").
// Единственная точка правды здесь — префиксный список ниже, ничего не
// перечисляется дважды.
const SITEMAP_EXCLUDE_PREFIXES = ["/admin", "/my", "/auth", "/assistant-test"];

function isPublicSitemapPage(page) {
  const path = new URL(page).pathname;
  return !SITEMAP_EXCLUDE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export default defineConfig({
  site: siteConfig.url,
  integrations: [mdx(), tailwind(), sitemap({ filter: isPublicSitemapPage }), react()],
  build: { format: "directory" },
  output: "hybrid",
  adapter: node({
    mode: "standalone",
  }),
  vite: {
    ssr: {
      // `feed.xml.ts` (prerender = true) использует пакет `rss`, который
      // тянет Node-only `fs`. Он реально выполняется только во время сборки
      // (страница полностью статическая) — держим его external и под
      // Node-адаптером тоже: `fs` доступен в рантайме Node без проблем, но
      // нет смысла тянуть весь `rss` в SSR-бандл ради страницы, которая
      // всегда prerender'ится и никогда не выполняется в рантайме SSR.
      external: ["rss"],
    },
    build: {
      rollupOptions: {
        // ТЗ "Доведение UI до рабочего состояния", п.2-3 — SearchBar.astro
        // делает `import("/pagefind/pagefind.js")` в браузере: это
        // сгенерированный pagefind CLI файл, которого физически нет на
        // диске во время `astro build` (см. package.json — pagefind
        // запускается ПОСЛЕ astro build отдельным шагом). Без этой записи
        // Rollup пытается разрешить путь на этапе сборки и падает с
        // ошибкой. `external` говорит Rollup оставить этот import(...) как
        // есть в собранном коде — браузер разрешит его сам во время
        // выполнения, когда файл уже физически лежит в dist/client/pagefind/.
        external: ["/pagefind/pagefind.js"],
      },
    },
  },
});
