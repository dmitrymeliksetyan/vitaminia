#!/usr/bin/env node
// Регрессионный тест server-side timeout'а AI-стратега (ТЗ "AI-стратег всё
// ещё не завершает run — диагностика", п.4): "если AI-вызов дольше лимита —
// завершить run как interrupted; не оставлять запись в running."
//
// Проверяет РЕАЛЬНЫЙ код — src/lib/content-editor/stages/with-deadline.ts,
// тот самый raceWithDeadline(), которым strategy-pipeline.ts оборачивает
// весь конвейер в runStrategyStagePipelineGuarded(). Именно этот файл (а не
// сам strategy-pipeline.ts) вынесен без зависимости от astro:content —
// специально чтобы механику "гонки с дедлайном" можно было реально
// прогнать обычным Node-скриптом, а не только проверить typecheck'ом.
//
// Запуск: npm run test:strategy-deadline

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function log(msg) {
  console.log(`[test:strategy-deadline] ${msg}`);
}
function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const srcPath = join(repoRoot, "src/lib/content-editor/stages/with-deadline.ts");
  const bundlePath = join(tmpdir(), `with-deadline-test-${Date.now()}-${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [srcPath], bundle: true, platform: "node", format: "esm", outfile: bundlePath });
  const { raceWithDeadline } = await import(`file://${bundlePath}`);
  rmSync(bundlePath, { force: true });

  // --- Сценарий 1: work() успевает раньше дедлайна — обычный успех, timeout
  // НЕ должен вызываться. ---
  let timeoutCalled1 = false;
  const fastWork = sleep(30).then(() => "REAL_RESULT");
  const result1 = await raceWithDeadline(fastWork, 500, () => {
    timeoutCalled1 = true;
    return "TIMEOUT_RESULT";
  });
  if (result1 !== "REAL_RESULT") fail(`Сценарий 1 (work успевает раньше дедлайна): ожидался "REAL_RESULT", получено "${result1}"`);
  if (timeoutCalled1) fail("Сценарий 1: onTimeout() вызван, хотя work() успел раньше дедлайна — гонка сработала неверно");
  log("Сценарий 1 (work быстрее дедлайна): раса выиграна реальным результатом, onTimeout() не вызывался — OK.");

  // --- Сценарий 2 (ключевой, воспроизводит живой баг): work() "виснет"
  // дольше дедлайна (симулирует именно то, что происходило в бою — AI-вызов
  // либо сама платформа не отвечают внутри разумного времени) — дедлайн
  // ОБЯЗАН сработать первым, вызвать onTimeout() (в реальном коде — запись
  // 'interrupted' в БД) и не ждать work() до его завершения. ---
  const startedAt = Date.now();
  let timeoutCalled2 = false;
  const hangingWork = sleep(5000).then(() => "REAL_RESULT_TOO_LATE"); // work "виснет" 5с — намного дольше дедлайна
  const result2 = await raceWithDeadline(hangingWork, 200, async () => {
    timeoutCalled2 = true;
    await sleep(10); // имитация асинхронной записи в БД внутри onTimeout
    return "INTERRUPTED_BY_DEADLINE";
  });
  const elapsedMs = Date.now() - startedAt;

  if (!timeoutCalled2) fail("Сценарий 2 (work виснет дольше дедлайна): onTimeout() НЕ был вызван — это и есть живой баг (run остаётся в running навсегда)");
  if (result2 !== "INTERRUPTED_BY_DEADLINE") fail(`Сценарий 2: ожидался результат onTimeout() "INTERRUPTED_BY_DEADLINE", получено "${result2}"`);
  if (elapsedMs > 1000) fail(`Сценарий 2: raceWithDeadline() вернулся через ${elapsedMs}мс — должен был вернуться сразу после дедлайна (~200мс), а не ждать зависший work() (5000мс)`);
  log(`Сценарий 2 (work виснет дольше дедлайна, ключевой для бага): дедлайн сработал первым за ${elapsedMs}мс (<1000мс, а не ждал 5000мс зависшего work), onTimeout() вызван и его результат вернулся — OK.`);

  console.log("\n✅ PASS: test:strategy-deadline");
}

main().catch((err) => fail(String(err?.stack ?? err)));
