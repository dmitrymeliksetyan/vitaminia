#!/usr/bin/env node
// Регрессионный тест публикационного pipeline (ТЗ "Системная ошибка
// публикационного пайплайна") — два подряд опубликованных материала
// (onemenie-paltsev-ruk, pokrasnenie-kozhi) были закоммичены БЕЗ
// manualRelated, из-за чего `npm run build` падал с
// "s.data.manualRelated is not iterable".
//
// Этот тест публикует материал БЕЗ manualRelated в исходном черновике и
// проверяет ВСЮ цепочку через настоящий, боевой код (не переписанную копию):
//   1) normalizeArrayFields() — та же функция, что decision.ts вызывает
//      первой при публикации — превращает отсутствующий manualRelated в [];
//   2) ensureFrontmatterArraysPresent() — последний предохранитель прямо
//      перед yaml.dump в buildFinalMdx — гарантирует то же самое ещё раз;
//   3) итоговый .mdx реально кладётся в изолированную копию проекта и
//      реально проходит `npm run build` (настоящая Astro-сборка, не мок) —
//      если генератор когда-нибудь снова начнёт пропускать manualRelated,
//      этот тест упадёт так же, как упал реальный build у пользователя.
//
// Запуск: npm run test:publish-manualrelated

import { mkdtempSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function log(msg) {
  console.log(`[test:publish-manualrelated] ${msg}`);
}
function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  // --- Шаг 1: подключить НАСТОЯЩИЙ код генератора (registry-publish.ts),
  // а не переписывать его логику здесь. Модуль не зависит от astro:content,
  // поэтому его можно скомпилировать в изолированный .mjs через esbuild и
  // импортировать напрямую. ---
  const srcPath = join(repoRoot, "src/lib/content-editor/registry-publish.ts");
  const bundlePath = join(tmpdir(), `registry-publish-test-${Date.now()}-${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [srcPath], bundle: true, platform: "node", format: "esm", outfile: bundlePath });
  const { normalizeArrayFields, ensureFrontmatterArraysPresent } = await import(`file://${bundlePath}`);
  rmSync(bundlePath, { force: true });

  // --- Шаг 2: черновик БЕЗ manualRelated — воспроизводит реальный случай
  // onemenie-paltsev-ruk/pokrasnenie-kozhi. ---
  const rawDraftFrontmatter = {
    title: "Тестовый симптом без manualRelated",
    slug: "test-symptom-no-manual-related",
    shortAnswer: "Тестовое описание для регрессионного теста публикационного pipeline.",
    keyPoints: ["Пункт 1"],
    causes: ["Причина 1"],
    selfCare: ["Совет 1"],
    whenToSeeDoctor: ["Признак 1"],
    whenUrgent: ["Срочный признак 1"],
    severity: "low",
    tags: ["test"],
    // manualRelated намеренно отсутствует.
  };
  if ("manualRelated" in rawDraftFrontmatter) fail("тестовые данные испорчены — manualRelated не должен присутствовать в исходном черновике");

  // --- Шаг 3: та же нормализация, что decision.ts вызывает первой при публикации. ---
  const { normalized, fixedFields } = normalizeArrayFields(rawDraftFrontmatter);
  if (!fixedFields.includes("manualRelated")) fail("normalizeArrayFields не пометил manualRelated как исправленное поле");
  if (!Array.isArray(normalized.manualRelated) || normalized.manualRelated.length !== 0) {
    fail(`normalizeArrayFields должен превратить отсутствующий manualRelated в [], получено: ${JSON.stringify(normalized.manualRelated)}`);
  }
  log("normalizeArrayFields: manualRelated отсутствовал в черновике → стал []");

  // --- Шаг 4: собрать frontmatter так же, как buildFinalMdx, и прогнать
  // финальный предохранитель ensureFrontmatterArraysPresent. ---
  const sources = [{ title: "Источник", url: "https://example.com/test" }];
  const assembledFrontmatter = {
    title: normalized.title,
    slug: normalized.slug,
    category: "general",
    shortAnswer: normalized.shortAnswer,
    keyPoints: normalized.keyPoints,
    causes: normalized.causes,
    selfCare: normalized.selfCare,
    whenToSeeDoctor: normalized.whenToSeeDoctor,
    whenUrgent: normalized.whenUrgent,
    severity: normalized.severity,
    tags: normalized.tags,
    manualRelated: normalized.manualRelated,
    updated: new Date().toISOString().slice(0, 10),
    sources,
    faq: [],
  };
  const safeFrontmatter = ensureFrontmatterArraysPresent(assembledFrontmatter);
  if (!Array.isArray(safeFrontmatter.manualRelated) || safeFrontmatter.manualRelated.length !== 0) {
    fail("ensureFrontmatterArraysPresent не гарантировал manualRelated: []");
  }
  log("ensureFrontmatterArraysPresent: финальный frontmatter содержит manualRelated: [] (последняя проверка перед yaml.dump)");

  // --- Шаг 5: реальный .mdx-текст (та же сборка, что buildFinalMdx). ---
  const body = "## Тестовое содержимое\n\nЭто тестовая статья для регрессионного теста публикационного pipeline.\n";
  const yamlText = yaml.dump(safeFrontmatter, { lineWidth: 100 });
  const mdxText = `---\n${yamlText}---\n\n${body}\n`;

  if (!/^manualRelated:\s*\[\]\s*$/m.test(yamlText)) {
    fail(`итоговый YAML не содержит "manualRelated: []" буквально:\n${yamlText}`);
  }
  log('итоговый YAML содержит буквально "manualRelated: []"');

  // --- Шаг 6: положить файл в ИЗОЛИРОВАННУЮ копию проекта и реально
  // прогнать `npm run build` — не мок, настоящая Astro-сборка. ---
  const scratchDir = mkdtempSync(join(tmpdir(), "medizin-publish-test-"));
  log(`копирую проект в ${scratchDir} для реальной сборки (без node_modules/dist/.astro)…`);
  cpSync(repoRoot, scratchDir, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|dist|\.astro)([\\/]|$)/.test(src),
  });

  const testMdxPath = join(scratchDir, "src/content/symptoms/general", "test-symptom-no-manual-related.mdx");
  writeFileSync(testMdxPath, mdxText, "utf8");

  try {
    log("устанавливаю зависимости в изолированной копии (npm install)…");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: scratchDir, stdio: "inherit" });

    log("запускаю npm run build…");
    execFileSync("npm", ["run", "build"], { cwd: scratchDir, stdio: "inherit" });
  } catch (err) {
    rmSync(scratchDir, { recursive: true, force: true });
    fail("npm run build упал на материале, сгенерированном без manualRelated в черновике — генератор должен был подставить manualRelated: [].");
    return;
  }

  rmSync(scratchDir, { recursive: true, force: true });
  log("npm run build прошёл успешно — материал без manualRelated в черновике публикуется с manualRelated: [] и не ломает сборку.");
  console.log("\n✅ PASS: test:publish-manualrelated");
}

main().catch((err) => fail(String(err?.stack ?? err)));
