#!/usr/bin/env node
// Регрессионный тест исправления завершения старых незавершённых запусков
// AI-стратега ("run остаётся незавершённым, кнопка «Продолжить» не создаёт
// контент-план; у старых run raw_candidates пустое") + ТЗ "Архитектура AI
// Strategy должна быть упрощена" (AI больше не присылает
// duplicateRisk/demandScore/conversionIntentScore/medicalBreadthScore/
// searchIntent/relatedContentTitles — RawCandidate теперь только
// title/proposedSlug/category/rationale?, весь анализ и приоритизация целиком
// в коде).
//
// Проверяет РЕАЛЬНЫЙ, боевой код (не переписанную копию):
//   1) dedupeAndScoreCandidates() (strategy-dedupe.ts) — три РАЗНЫЕ причины
//      исключения кандидата (excludedDuplicateCount / excludedHistoryCount /
//      excludedInPlanCount) должны считаться в РАЗНЫЕ счётчики, а не
//      сливаться в один "дубли" (п.4 ТЗ: "исключено как дубли; исключено по
//      истории; исключено как уже находящееся в плане" — три отдельные
//      цифры отчёта);
//   2) STRATEGY_TO_REASON / priorityToIdeaPriority — то же самое
//      сопоставление, что использует strategy-pipeline.ts при автоматическом
//      сохранении контент-плана (raw_candidates → dedupe → ... →
//      content_ideas → completed), даёт валидную форму строки content_ideas;
//   3) computeCompetitionOpportunityScore() и итоговая формула приоритета
//      (contentGapScore*0.6 + competitionOpportunityScore*0.4) — целиком
//      code-only, без единого AI-суждения (ТЗ "AI Strategy упрощена", п.5).
//
// Живой E2E-тест с реальным Supabase (создание run, checkpoint
// raw_candidates, автосохранение content_ideas, статус completed) был
// проведён отдельно, напрямую против боевой БД проекта — см. финальный
// отчёт. Этот скрипт — часть постоянного регрессионного набора (не требует
// сетевых учётных данных, можно гонять в CI).
//
// Запуск: npm run test:strategy-autocomplete

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function log(msg) {
  console.log(`[test:strategy-autocomplete] ${msg}`);
}
function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  const srcPath = join(repoRoot, "src/lib/content-editor/strategy-dedupe.ts");
  const bundlePath = join(tmpdir(), `strategy-dedupe-test-${Date.now()}-${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [srcPath], bundle: true, platform: "node", format: "esm", outfile: bundlePath });
  const { dedupeAndScoreCandidates, STRATEGY_TO_REASON, priorityToIdeaPriority, computeCompetitionOpportunityScore, computeContentGapScore } = await import(`file://${bundlePath}`);
  rmSync(bundlePath, { force: true });

  // --- Синтетический, но реалистичный Registry/контент-план ---
  const registryItems = [
    { id: "SYM-001", contentType: "symptom", status: "published", retired: false, category: "cardio", title: "Боль в груди", slug: "chest-pain", tags: ["боль"] },
    { id: "SYM-RET-1", contentType: "symptom", status: "merge", retired: true, category: "general", title: "Повышенная потливость", slug: "excessive-sweating" },
  ];
  const existingIdeaTitles = ["Периодическая мигрень"];

  // ТЗ "AI Strategy упрощена" — RawCandidate теперь только
  // title/proposedSlug/category/rationale? (никаких оценочных полей от AI).
  const rawCandidates = [
    // 1) точный дубль опубликованного материала → excludedDuplicateCount
    { title: "Боль в груди", proposedSlug: "x1", category: "cardio", rationale: "r" },
    // 2) совпадение с retired темой → excludedHistoryCount
    { title: "Повышенная потливость", proposedSlug: "x2", category: "general", rationale: "r" },
    // 3) совпадение с уже существующей идеей контент-плана → excludedInPlanCount (ОТДЕЛЬНО от 1 и 2!)
    { title: "Периодическая мигрень", proposedSlug: "x3", category: "head", rationale: "r" },
    // 4) настоящая новая тема → должна остаться (kept)
    { title: "Совершенно новая уникальная тема XYZ", proposedSlug: "x4", category: "neuro", rationale: "r" },
  ];

  const result = dedupeAndScoreCandidates(rawCandidates, registryItems, existingIdeaTitles);

  if (result.excludedDuplicateCount !== 1) fail(`excludedDuplicateCount должен быть 1 (точный дубль опубликованного), получено ${result.excludedDuplicateCount}`);
  if (result.excludedHistoryCount !== 1) fail(`excludedHistoryCount должен быть 1 (retired-тема), получено ${result.excludedHistoryCount}`);
  if (result.excludedInPlanCount !== 1) fail(`excludedInPlanCount должен быть 1 (уже в контент-плане) — п.4 ТЗ требует ОТДЕЛЬНЫЙ счётчик от excludedDuplicateCount, получено ${result.excludedInPlanCount}`);
  if (result.kept.length !== 1 || result.kept[0].title !== "Совершенно новая уникальная тема XYZ") {
    fail(`kept должен содержать ровно 1 настоящую новую тему, получено: ${JSON.stringify(result.kept.map((k) => k.title))}`);
  }
  log("dedupeAndScoreCandidates: excludedDuplicateCount=1, excludedHistoryCount=1, excludedInPlanCount=1 (три РАЗНЫХ счётчика) — как требует п.4 ТЗ.");

  // --- STRATEGY_TO_REASON / priorityToIdeaPriority — форма строки content_ideas,
  // которую strategy-pipeline.ts вставляет автоматически (raw_candidates → ... → content_ideas → completed). ---
  if (STRATEGY_TO_REASON.max_traffic !== "search_demand") fail("STRATEGY_TO_REASON.max_traffic должен быть search_demand");
  if (priorityToIdeaPriority("P0") !== "high" || priorityToIdeaPriority("P2") !== "medium" || priorityToIdeaPriority("P3") !== "low") {
    fail("priorityToIdeaPriority: неверное сопоставление P0-P3 → high/medium/low");
  }
  log("STRATEGY_TO_REASON/priorityToIdeaPriority: сопоставление совпадает с тем, что использует автосохранение контент-плана.");

  // --- ТЗ "AI Strategy упрощена", п.5: приоритет — целиком code-only формула
  // из ДВУХ детерминированных сигналов, без единого AI-суждения. ---
  const gapScore = computeContentGapScore("neuro", registryItems);
  const oppScoreUnique = computeCompetitionOpportunityScore("unique");
  const oppScoreOverlap = computeCompetitionOpportunityScore("possible_overlap");
  if (oppScoreUnique !== 90) fail(`computeCompetitionOpportunityScore("unique") должен быть 90, получено ${oppScoreUnique}`);
  if (oppScoreOverlap !== 55) fail(`computeCompetitionOpportunityScore("possible_overlap") должен быть 55, получено ${oppScoreOverlap}`);

  const kept4 = result.kept.find((k) => k.title === "Совершенно новая уникальная тема XYZ");
  const expectedPriorityScore = Math.round(gapScore * 0.6 + oppScoreUnique * 0.4);
  if (!kept4) fail("ожидаемый kept-кандидат не найден для проверки формулы приоритета");
  if (kept4.contentGapScore !== gapScore) fail(`contentGapScore кандидата (${kept4.contentGapScore}) должен совпадать с computeContentGapScore (${gapScore})`);
  if (kept4.competitionOpportunityScore !== oppScoreUnique) fail(`competitionOpportunityScore кандидата (${kept4.competitionOpportunityScore}) должен быть ${oppScoreUnique} (unique)`);
  if (kept4.priorityScore !== expectedPriorityScore) fail(`priorityScore должен быть contentGapScore*0.6 + competitionOpportunityScore*0.4 = ${expectedPriorityScore}, получено ${kept4.priorityScore}`);
  if (kept4.demandScore !== undefined || kept4.searchIntent !== undefined || kept4.relatedContentTitles !== undefined) {
    fail("kept-кандидат не должен содержать demandScore/searchIntent/relatedContentTitles — эти поля от AI больше не приходят и код их не выдумывает");
  }
  log(`Формула приоритета code-only: priorityScore=${kept4.priorityScore} = contentGapScore(${gapScore})*0.6 + competitionOpportunityScore(${oppScoreUnique})*0.4, без единого AI-поля.`);

  console.log("\n✅ PASS: test:strategy-autocomplete");
}

main().catch((err) => fail(String(err?.stack ?? err)));
