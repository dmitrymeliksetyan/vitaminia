#!/usr/bin/env node
// Регрессионный тест ТЗ "автономное производство статей и снижение
// стоимости AI-редакции".
//
// Не может выполнить реальный платный E2E-прогон (нет ANTHROPIC_API_KEY в
// этой песочнице — та же ограниченность сандбокса, что и во всех предыдущих
// проверках этого проекта). Вместо этого мокает fetch() к api.anthropic.com
// и проверяет РЕАЛЬНЫЙ боевой код оркестрации (pipeline.ts::
// runMedicalReviewStage/runFinalReviewStage — те же функции, что вызывает
// advance.ts) на всех решающих сценариях нового ТЗ:
//
//  1) Вызов 3 возвращает decision:"ready" без appliedFixes — не needs_decision.
//  2) Вызов 3 возвращает decision:"ready_with_notes" С appliedFixes — не
//     needs_decision (некритические замечания НЕ останавливают конвейер,
//     п.3/6 ТЗ) — это и есть сигнал "нужен Вызов 4".
//  3) Вызов 3 возвращает decision:"blocked" с criticalIssues — ЕДИНСТВЕННЫЙ
//     случай status:"needs_decision" (п.3/6 ТЗ: реальный блокер).
//  4) Вызов 4 (final_review) подтверждает исправления (finalDecision:"ready")
//     — не needs_decision.
//  5) Вызов 4 обнаруживает, что само исправление создало проблему
//     (finalDecision:"blocked") — needs_decision (редкий случай п.3 ТЗ).
//
// Запуск: npm run test:autonomous-production-pipeline

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function log(msg) {
  console.log(`[test:autonomous-production-pipeline] ${msg}`);
}
function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

function mockAnthropicResponse(toolName, input) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: "tool_use", name: toolName, input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 500, output_tokens: 200 },
    }),
    text: async () => "",
  };
}

async function main() {
  const srcPath = join(repoRoot, "src/lib/content-editor/pipeline.ts");
  const bundlePath = join(tmpdir(), `pipeline-test-${Date.now()}-${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [srcPath], bundle: true, platform: "node", format: "esm", outfile: bundlePath });
  const { runMedicalReviewStage, runFinalReviewStage } = await import(`file://${bundlePath}`);
  rmSync(bundlePath, { force: true });

  const originalFetch = global.fetch;
  let lastCallBody = null;
  function installMock(toolName, input) {
    global.fetch = async (url, opts) => {
      lastCallBody = JSON.parse(opts.body);
      return mockAnthropicResponse(toolName, input);
    };
  }

  try {
    // === Сценарий 1: Вызов 3 — ready, appliedFixes пуст. ===
    installMock("record_medical_review_and_fix", {
      confirmedCount: 10,
      criticalIssues: [],
      warnings: [],
      appliedFixes: [],
      decision: "ready",
    });
    const r1 = await runMedicalReviewStage("fake-key", "claude-sonnet-5", { draft: { frontmatter: {} }, researchBrief: {} });
    if (r1.status !== "ok") fail(`Сценарий 1 (ready, без правок): ожидался status "ok", получено "${r1.status}"`);
    if ((r1.output.appliedFixes ?? []).length !== 0) fail("Сценарий 1: appliedFixes должен быть пуст");
    log("Сценарий 1 (Вызов 3, ready, без правок): status=ok, appliedFixes пуст — конвейер пойдёт сразу в seo_review (3 вызова) — OK.");

    // === Сценарий 2: Вызов 3 — ready_with_notes, С appliedFixes (единственный тест, где нужен Вызов 4). ===
    installMock("record_medical_review_and_fix", {
      confirmedCount: 8,
      criticalIssues: [],
      warnings: [{ field: "frontmatter.selfCare.2", issue: "чуть категорично" }],
      appliedFixes: [{ field: "frontmatter.selfCare.1", originalFragment: "старый текст", newValue: "новый текст", reason: "уточнение формулировки" }],
      decision: "ready_with_notes",
    });
    const r2 = await runMedicalReviewStage("fake-key", "claude-sonnet-5", { draft: { frontmatter: {} }, researchBrief: {} });
    if (r2.status !== "ok") fail(`Сценарий 2 (ready_with_notes с правками): некритические замечания НЕ должны давать needs_decision, получено "${r2.status}"`);
    if ((r2.output.appliedFixes ?? []).length !== 1) fail("Сценарий 2: appliedFixes должен содержать ровно 1 правку");
    log("Сценарий 2 (Вызов 3, ready_with_notes, 1 правка применена САМИМ редактором в этом же вызове): status=ok — needs_decision НЕ произошёл, конвейер продолжится на Вызов 4 — OK.");

    // === Сценарий 3: Вызов 3 — blocked, реальный критический блокер. ===
    installMock("record_medical_review_and_fix", {
      confirmedCount: 5,
      criticalIssues: [{ field: "frontmatter.whenUrgent.0", originalFragment: "текст", issue: "пропущен красный флаг" }],
      warnings: [],
      appliedFixes: [],
      decision: "blocked",
    });
    const r3 = await runMedicalReviewStage("fake-key", "claude-sonnet-5", { draft: { frontmatter: {} }, researchBrief: {} });
    if (r3.status !== "needs_decision") fail(`Сценарий 3 (blocked, criticalIssues не пуст): ЕДИНСТВЕННЫЙ случай needs_decision, получено "${r3.status}"`);
    log("Сценарий 3 (Вызов 3, blocked, реальный criticalIssue): status=needs_decision — производство корректно остановлено — OK.");

    // === Сценарий 4: Вызов 4 (final_review) — подтверждено, всё чисто. ===
    installMock("record_final_review", { confirmed: 1, remainingWarnings: [], criticalIssues: [], finalDecision: "ready" });
    const r4 = await runFinalReviewStage("fake-key", "claude-haiku-4-5-20251001", { title: "Тест", fixes: [{ field: "frontmatter.selfCare.1", originalFragment: "старый текст", newValue: "новый текст", reason: "уточнение" }] });
    if (r4.status !== "ok") fail(`Сценарий 4 (Вызов 4, ready): ожидался status "ok", получено "${r4.status}"`);
    // Экономика (п.12 ТЗ): проверяем, что Вызов 4 НЕ отправил ни всю статью,
    // ни весь research brief — только сами исправления.
    const sentPromptText = JSON.stringify(lastCallBody.messages);
    if (sentPromptText.includes('"frontmatter":{}') || sentPromptText.length > 2000) {
      fail(`Сценарий 4: похоже, Вызов 4 отправил больше, чем только исправления (длина промпта ${sentPromptText.length} симв.) — нарушение экономии токенов (п.12 ТЗ)`);
    }
    log(`Сценарий 4 (Вызов 4, ready): status=ok, промпт компактный (${sentPromptText.length} симв., только применённые фрагменты, без всей статьи/research brief) — OK.`);

    // === Сценарий 5: Вызов 4 обнаруживает проблему В САМОМ исправлении (редкий случай). ===
    installMock("record_final_review", { confirmed: 0, remainingWarnings: [], criticalIssues: [{ field: "frontmatter.selfCare.1", issue: "исправление ввело неточность" }], finalDecision: "blocked" });
    const r5 = await runFinalReviewStage("fake-key", "claude-haiku-4-5-20251001", { title: "Тест", fixes: [{ field: "frontmatter.selfCare.1", originalFragment: "старый", newValue: "новый", reason: "уточнение" }] });
    if (r5.status !== "needs_decision") fail(`Сценарий 5 (Вызов 4, blocked): ожидался status "needs_decision", получено "${r5.status}"`);
    log("Сценарий 5 (Вызов 4, само исправление создало проблему — редкий случай п.3 ТЗ): status=needs_decision — OK.");

    console.log("\n✅ PASS: test:autonomous-production-pipeline");
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((err) => fail(String(err?.stack ?? err)));
