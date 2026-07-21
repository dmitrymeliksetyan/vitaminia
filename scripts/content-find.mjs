#!/usr/bin/env node
/**
 * npm run content:find -- "Потливость"
 *
 * Searches the Content Registry for an existing/duplicate/related topic
 * BEFORE a new symptom page gets written. This is the tool a developer or an
 * AI assistant must run first, per the project rule:
 * "a new content page must not be created before an automatic Content Registry check."
 *
 * The actual matching algorithm lives in src/lib/content-registry/search.mjs
 * and is shared verbatim with the admin UI's search box (Этап 1.5) — this
 * file only builds the registry (Node/fs) and formats the result for the
 * terminal.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "vitaminia-shared/content-registry/content-registry-lib.mjs";
import { searchRegistry } from "vitaminia-shared/content-registry/search.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function main() {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.log('Usage: npm run content:find -- "Название темы"');
    process.exit(1);
  }

  const { items } = buildRegistry(ROOT);
  const { exactLive, exactRetired, similar, recommendation } = searchRegistry(items, query);

  console.log(`${BOLD}Search: ${query}${RESET}\n`);

  if (exactLive.length > 0) {
    console.log(`${GREEN}${BOLD}EXACT MATCH${RESET}`);
    for (const i of exactLive) {
      console.log(`${i.id}`);
      console.log(i.title);
      console.log(i.url);
      console.log(`Status: ${i.status}${i.quality ? `\nQuality: ${i.quality}` : ""}`);
      if (i.status === "duplicate" && i.duplicateOf) {
        console.log(`${YELLOW}duplicateOf: ${i.duplicateOf}${RESET}`);
      }
      if (i.notes) console.log(`${DIM}Notes: ${i.notes}${RESET}`);
      console.log("");
    }
  } else if (exactRetired.length === 0) {
    console.log(`${YELLOW}No exact match — no page with this exact title/slug exists yet.${RESET}\n`);
  }

  if (exactRetired.length > 0) {
    console.log(`${YELLOW}${BOLD}RETIRED / MERGED — this exact topic was already resolved once${RESET}`);
    for (const i of exactRetired) {
      console.log(`${i.id} (${i.status === "merge" ? "объединена" : "удалена как дубль"})`);
      console.log(i.title);
      console.log(`было: ${i.url}`);
      if (i.redirect) console.log(`редирект → ${i.redirect}`);
      if (i.duplicateOf) console.log(`canonical: ${i.duplicateOf}`);
      if (i.notes) console.log(`${DIM}${i.notes}${RESET}`);
      console.log("");
    }
  }

  if (similar.length > 0) {
    console.log(`${CYAN}${BOLD}SIMILAR CONTENT${RESET}`);
    for (const r of similar) {
      const i = r.item;
      const reason =
        r.sharedTokens.length > 0
          ? `shared words: ${r.sharedTokens.join(", ")}`
          : r.tagOverlap.length > 0
          ? `shared tags: ${r.tagOverlap.join(", ")}`
          : `title similarity ${(r.titleSim * 100).toFixed(0)}%`;
      console.log(`${i.id}`);
      console.log(i.title);
      console.log(i.url);
      console.log(`Relationship: related (${reason})`);
      console.log("");
    }
  }

  console.log(`${BOLD}Recommendation:${RESET}`);
  if (recommendation === "exists") {
    console.log("Такая страница уже существует — не создавайте новую. При необходимости — обновите существующую.");
  } else if (recommendation === "retired") {
    console.log(
      "Эта тема уже рассматривалась и была объединена/удалена ранее (см. RETIRED / MERGED выше) — не создавайте " +
        "её заново под тем же смыслом. Если действительно нужна отдельная страница — берите другой H1 и другой " +
        "поисковый смысл, не просто пересоздавайте то же самое."
    );
  } else if (recommendation === "check_similar") {
    console.log(
      "Точного совпадения нет, но есть очень похожая тема (см. SIMILAR CONTENT выше) — проверьте вручную, " +
        "это отдельная тема, дочерняя тема или потенциальный дубль, прежде чем создавать новую страницу."
    );
  } else if (recommendation === "safe_with_related") {
    console.log("Явных дублей не найдено. Есть смежные темы — рассмотрите перелинковку. Создавать новую страницу безопасно.");
  } else {
    console.log("Совпадений и явно похожих тем не найдено. Создавать новую страницу безопасно.");
  }
}

main();
