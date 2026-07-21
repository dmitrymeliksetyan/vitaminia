#!/usr/bin/env node
/**
 * npm run content:backlog
 *
 * Regenerates docs/content-audit/CONTENT_BACKLOG.md from the single source
 * of truth: src/lib/content-registry/queue.mjs (which itself derives P0/P1
 * live from the Content Registry, and reads the tiny hand-maintained
 * src/data/content-backlog.technical.mjs for P2/P3 technical items).
 *
 * Never hand-edit CONTENT_BACKLOG.md directly — edit technicalBacklog for
 * technical items, or fix the underlying content/quality for P1 items, then
 * re-run this script.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "vitaminia-shared/content-registry/content-registry-lib.mjs";
import { buildQueue } from "../src/lib/content-registry/queue.mjs";

// Этап "Выделение AI Worker в отдельный независимый сервис" — ROOT больше не
// экспортируется из content-registry-lib.mjs (buildRegistry теперь принимает
// rootDir параметром, см. vitaminia-shared/README.md), поэтому вычисляем его
// здесь же, локально, как и раньше делал content-registry-lib.mjs сам.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const OUT_PATH = path.join(ROOT, "docs/content-audit/CONTENT_BACKLOG.md");

function section(title, items, emptyText) {
  let out = `## ${title}\n\n`;
  if (items.length === 0) {
    out += `${emptyText}\n\n`;
    return out;
  }
  for (const item of items) {
    const idPart = item.id ? `**${item.id}** — ` : "";
    out += `- ${idPart}${item.title}. ${item.description}\n`;
  }
  return out + "\n";
}

function main() {
  const { items, problems } = buildRegistry(ROOT);
  const { p0, p1, p2, p3 } = buildQueue(items, problems);

  const date = new Date().toISOString().slice(0, 10);

  let md = `# MEDIZIN Content Backlog\n\n`;
  md += `_Автоматически сгенерировано ${date} командой \`npm run content:backlog\` из Content Registry + \`src/data/content-backlog.technical.mjs\`. Не редактировать руками — правки P1 вносятся через контент/качество страниц, P0/P2/P3 — через technicalBacklog._\n\n`;
  md += section("P0 — технические проблемы", p0, "Нет открытых P0-проблем.");
  md += section("P1 — требуют доработки", p1, "Нет страниц, требующих доработки.");
  md += section("P2 — улучшения", p2, "Нет открытых P2-задач.");
  md += section("P3 — новый контент", p3, "Пока пусто — массовое создание нового контента не начато.");
  md += `## Процессное правило\n\nНи одна новая тема не создаётся без предварительного \`npm run content:find -- "Название темы"\` и без чистого \`npm run content:check\` после добавления записи в \`content-registry.ids.json\`.\n`;

  fs.writeFileSync(OUT_PATH, md, "utf-8");
  console.log(`Written ${OUT_PATH}`);
  console.log(`P0: ${p0.length}, P1: ${p1.length}, P2: ${p2.length}, P3: ${p3.length}`);
}

main();
