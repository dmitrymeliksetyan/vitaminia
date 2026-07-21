#!/usr/bin/env node
// Регрессионный тест ТЗ "не блокировать публикацию из-за отсутствия
// источников".
//
// Проверяет РЕАЛЬНЫЙ боевой код:
//   1) validateSymptomFrontmatter(fm, category, sourcesCount=0) — errors
//      ПУСТ (публикация не блокируется), warnings содержит ровно одну
//      запись про sources — "Источники отсутствуют".
//   2) Тот же материал с валидными полями, но sourcesCount>0 — warnings
//      про sources отсутствует.
//   3) Материал БЕЗ обязательного технического поля (например title) —
//      ВСЁ ЕЩЁ блокирует (errors не пуст), даже если sources в порядке —
//      п.2 ТЗ: технические ошибки по-прежнему блокируют.
//   4) computeContentHealth() (seo-health.mjs) — symptom без sources
//      получает status:"warning" (не "critical") и warnings содержит
//      "Не указаны источники" — то, что реально видит админ в Библиотеке
//      контента (п.3-4 ТЗ).
//
// Запуск: npm run test:publish-without-sources

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function log(msg) {
  console.log(`[test:publish-without-sources] ${msg}`);
}
function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

const VALID_FM = {
  title: "Тестовая статья",
  slug: "testovaya-statya",
  shortAnswer: "Краткий ответ на вопрос читателя.",
  severity: "low",
  updated: "2026-07-12",
};

async function main() {
  // --- Часть 1: registry-publish.ts::validateSymptomFrontmatter ---
  const rpPath = join(repoRoot, "src/lib/content-editor/registry-publish.ts");
  const rpBundle = join(tmpdir(), `registry-publish-nosrc-${Date.now()}.mjs`);
  await esbuild.build({ entryPoints: [rpPath], bundle: true, platform: "node", format: "esm", outfile: rpBundle });
  const { validateSymptomFrontmatter } = await import(`file://${rpBundle}`);
  rmSync(rpBundle, { force: true });

  // Сценарий 1: sourcesCount=0 — публикация НЕ блокируется.
  const r1 = validateSymptomFrontmatter(VALID_FM, "general", 0);
  if (r1.errors.length !== 0) fail(`Сценарий 1: sources=0 не должен создавать errors, получено: ${JSON.stringify(r1.errors)}`);
  if (!r1.warnings.some((w) => w.field === "sources")) fail(`Сценарий 1: ожидался warning про sources, получено: ${JSON.stringify(r1.warnings)}`);
  log("Сценарий 1 (sourcesCount=0): errors пуст (публикация НЕ блокируется), warnings содержит sources — OK.");

  // Сценарий 2: sourcesCount>0 — предупреждения про sources нет.
  const r2 = validateSymptomFrontmatter(VALID_FM, "general", 3);
  if (r2.warnings.some((w) => w.field === "sources")) fail(`Сценарий 2: sourcesCount=3 не должен давать warning про sources`);
  log("Сценарий 2 (sourcesCount=3): warning про sources отсутствует — OK.");

  // Сценарий 3: реальный технический блокер (нет title) — ВСЁ ЕЩЁ блокирует.
  const r3 = validateSymptomFrontmatter({ ...VALID_FM, title: "" }, "general", 5);
  if (!r3.errors.some((e) => e.field === "title")) fail(`Сценарий 3: отсутствие title должно попасть в errors (реальный технический блокер), получено: ${JSON.stringify(r3.errors)}`);
  log("Сценарий 3 (нет title, sources есть): errors содержит title — технические блокеры по-прежнему работают — OK.");

  // --- Часть 2: seo-health.mjs::computeContentHealth ---
  const shPath = join(repoRoot, "src/lib/content-registry/seo-health.mjs");
  const shBundle = join(tmpdir(), `seo-health-nosrc-${Date.now()}.mjs`);
  await esbuild.build({ entryPoints: [shPath], bundle: true, platform: "node", format: "esm", outfile: shBundle });
  const { computeContentHealth } = await import(`file://${shBundle}`);
  rmSync(shBundle, { force: true });

  const itemNoSources = {
    id: "SYM-999", title: "Тест без источников", slug: "test-no-sources", url: "/symptoms/general/test-no-sources",
    contentType: "symptom", category: "general", status: "published", source: "test",
    titleTag: "Тест без источников — заголовок достаточной длины для проверки",
    metaDescription: "Достаточно длинное описание материала для прохождения проверки минимальной длины description в SEO-проверке.",
    h1: "Тест без источников", canonical: "/symptoms/general/test-no-sources", inSitemap: true,
    tags: ["тест"], manualRelated: [], severity: "low",
    sources: [], // ключевой сценарий этого ТЗ
  };
  const health = computeContentHealth([itemNoSources], []);
  const h = health.byId.get("SYM-999");
  if (!h) fail("computeContentHealth не вернул запись для тестового материала");
  if (h.status === "critical") fail(`Отсутствие sources НЕ должно давать status:"critical" (это не блокер публикации), получено: ${h.status}`);
  if (!h.warnings.includes("Не указаны источники")) fail(`Ожидался warning "Не указаны источники", получено: ${JSON.stringify(h.warnings)}`);
  log(`computeContentHealth (symptom без sources): status="${h.status}" (не critical), warnings содержит "Не указаны источники" — покажется в Библиотеке как "Есть замечания" — OK.`);

  const itemWithSources = { ...itemNoSources, id: "SYM-998", sources: [{ title: "Источник", url: "https://example.com" }] };
  const health2 = computeContentHealth([itemWithSources], []);
  const h2 = health2.byId.get("SYM-998");
  if (h2.warnings.includes("Не указаны источники")) fail("Материал С источниками не должен получать warning про отсутствие источников");
  log("computeContentHealth (symptom с sources): warning про источники отсутствует — OK.");

  console.log("\n✅ PASS: test:publish-without-sources");
}

main().catch((err) => fail(String(err?.stack ?? err)));
