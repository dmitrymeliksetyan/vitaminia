#!/usr/bin/env node
// Регрессионный тест критического бага генерации Registry ID.
//
// Живые данные показали SYM-094 выданным ЧЕТЫРЁМ разным материалам (Икота,
// Онемение пальцев рук, Что-то чешется в боку, Быстрое семяизвержение) в
// трёх РАЗНЫХ публикациях, разнесённых часами. Причина: computeNextSymptomId()/
// upsertSymptomIdEntry() раньше доверяли ЕДИНСТВЕННОМУ чтению
// content-registry.ids.json — без перепроверки против других независимых
// источников (живой Registry, retired, content_jobs.publish_registry_id).
// Если это чтение по любой причине не отражало уже выданные ID (устаревший
// ответ GitHub API, гонка публикаций и т.п.) — "следующий свободный" номер
// тихо повторялся.
//
// Проверяет РЕАЛЬНЫЙ, боевой код (../src/lib/content-editor/registry-publish.ts):
//   1) два материала, опубликованных подряд из ОДНОГО и того же ids.json,
//      получают РАЗНЫЕ ID (базовый сценарий п.7 ТЗ);
//   2) старый ID не перезаписывается — повторный upsert для УЖЕ известного
//      key возвращает тот же самый ID, а не создаёт новую запись;
//   3) ключевой сценарий реального бага: если ids.json ПО ЛЮБОЙ ПРИЧИНЕ не
//      отражает уже выданный ранее ID (симулируем "устаревшее" чтение —
//      передаём тот же исходный текст, что и для первого материала), но
//      additionalKnownIds (живой Registry/retired/content_jobs, которые
//      decision.ts теперь ВСЕГДА передаёт) корректно содержит уже выданный
//      ID — коллизия НЕ происходит: новый материал получает следующий
//      реально свободный номер, а не повторяет старый;
//   4) isSymptomIdTaken() — явная блокирующая проверка (п.6 ТЗ) — верно
//      определяет как занятые ID и из ids.json, и из additionalKnownIds.
//
// Запуск: npm run test:registry-id-uniqueness

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function log(msg) {
  console.log(`[test:registry-id-uniqueness] ${msg}`);
}
function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  const srcPath = join(repoRoot, "src/lib/content-editor/registry-publish.ts");
  const bundlePath = join(tmpdir(), `registry-publish-test-${Date.now()}-${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [srcPath], bundle: true, platform: "node", format: "esm", outfile: bundlePath });
  const { upsertSymptomIdEntry, computeNextSymptomId, isSymptomIdTaken } = await import(`file://${bundlePath}`);
  rmSync(bundlePath, { force: true });

  // --- Синтетический ids.json, обрывающийся на SYM-093 (как в реальном инциденте). ---
  const baseIds = JSON.stringify([
    { id: "SYM-092", type: "symptom", key: "womens-health/missed-period" },
    { id: "SYM-093", type: "symptom", key: "womens-health/vaginal-discharge" },
  ]);

  // === Сценарий 1 (п.7 ТЗ дословно): "публикация двух новых материалов
  // подряд → получают разные ID → старый ID не перезаписывается". ===
  const first = upsertSymptomIdEntry(baseIds, "lor", "ikota", []);
  if (first.id !== "SYM-094") fail(`первый материал должен получить SYM-094, получено ${first.id}`);
  if (!first.isNew) fail("первый материал (новый key) должен дать isNew:true");

  // Второй материал публикуется ПОСЛЕДОВАТЕЛЬНО, из ТЕКСТА, уже обновлённого
  // первой публикацией (именно так работает decision.ts — читает актуальный
  // ids.json перед КАЖДОЙ публикацией).
  const second = upsertSymptomIdEntry(first.text, "mens-health", "bystroe-semyaizverzhenie", []);
  if (second.id === first.id) fail(`второй материал получил ТОТ ЖЕ ID, что и первый (${second.id}) — критический баг не исправлен`);
  if (second.id !== "SYM-095") fail(`второй материал должен получить SYM-095, получено ${second.id}`);

  // Старый ID не перезаписан — первая запись всё ещё в тексте, с тем же ID/key.
  const secondArr = JSON.parse(second.text);
  const firstEntryStillThere = secondArr.find((e) => e.key === "lor/ikota");
  if (!firstEntryStillThere || firstEntryStillThere.id !== "SYM-094") {
    fail(`запись первого материала (lor/ikota → SYM-094) должна остаться нетронутой после второй публикации, получено: ${JSON.stringify(firstEntryStillThere)}`);
  }
  log("Сценарий 1: два материала подряд получили РАЗНЫЕ ID (094, 095), старая запись не перезаписана — OK.");

  // Повторный upsert для УЖЕ известного key (идемпотентность retry) — тот же ID, не новая запись.
  const retryFirst = upsertSymptomIdEntry(second.text, "lor", "ikota", []);
  if (retryFirst.id !== "SYM-094" || retryFirst.isNew) {
    fail(`повторный upsert для уже существующего key должен вернуть isNew:false и тот же ID SYM-094, получено: ${JSON.stringify(retryFirst)}`);
  }
  log("Идемпотентность: повторный upsert для существующего key не создаёт дубль — OK.");

  // === Сценарий 2 — ключевой для реального инцидента: ids.json "устарел"
  // (не видит уже выданный SYM-094), но additionalKnownIds (то, что теперь
  // ВСЕГДА передаёт decision.ts из живого Registry/retired/content_jobs)
  // корректно содержит его — коллизия не должна произойти. ===
  const staleIds = baseIds; // тот же исходный текст, БЕЗ записи SYM-094 — симулирует "устаревшее" чтение.
  const knownFromOtherSources = ["SYM-094"]; // уже выдан другому материалу, известен из Registry/jobs, но НЕ виден в staleIds.
  const thirdOnStaleFile = upsertSymptomIdEntry(staleIds, "general", "onemenie-paltsev-ruk", knownFromOtherSources);
  if (thirdOnStaleFile.id === "SYM-094") {
    fail(`РЕАЛЬНЫЙ БАГ ВОСПРОИЗВЕДЁН: при устаревшем ids.json и БЕЗ учёта additionalKnownIds материал снова получил бы SYM-094`);
  }
  if (thirdOnStaleFile.id !== "SYM-095") {
    fail(`при устаревшем ids.json, но с additionalKnownIds=["SYM-094"], материал должен получить SYM-095 (следующий реально свободный), получено ${thirdOnStaleFile.id}`);
  }
  log("Сценарий 2 (устаревший ids.json + известные ID из Registry/jobs): коллизия НЕ произошла, следующий ID вычислен корректно — OK.");

  // Тот же сценарий, но известных "чужих" ID сразу несколько подряд (как в
  // реальном инциденте — 094 занят четырьмя материалами до починки) —
  // алгоритм обязан перепрыгнуть через ВСЕ известные значения, а не только
  // через "computeNextSymptomId"-максимум.
  const manyKnown = ["SYM-094", "SYM-095", "SYM-096"];
  const fourthOnStaleFile = upsertSymptomIdEntry(staleIds, "general", "cheshetsya-v-boku", manyKnown);
  if (manyKnown.includes(fourthOnStaleFile.id)) {
    fail(`материал получил уже занятый ID ${fourthOnStaleFile.id} несмотря на manyKnown=${JSON.stringify(manyKnown)}`);
  }
  if (fourthOnStaleFile.id !== "SYM-097") fail(`ожидался SYM-097 (следующий свободный после 094-096), получено ${fourthOnStaleFile.id}`);
  log("Сценарий 2b (несколько занятых ID из внешних источников подряд): корректно перепрыгнуто через все — OK.");

  // === Сценарий 3 — computeNextSymptomId() учитывает additionalKnownIds напрямую. ===
  const nextId = computeNextSymptomId(staleIds, ["SYM-200"]);
  if (nextId !== "SYM-201") fail(`computeNextSymptomId с additionalKnownIds должен вернуть SYM-201, получено ${nextId}`);
  log("computeNextSymptomId(): additionalKnownIds корректно учитываются в максимуме — OK.");

  // === Сценарий 4 (п.6 ТЗ): isSymptomIdTaken — явная блокирующая проверка. ===
  if (!isSymptomIdTaken("SYM-093", baseIds, [])) fail('isSymptomIdTaken("SYM-093", ...) из ids.json должен быть true');
  if (isSymptomIdTaken("SYM-999", baseIds, [])) fail('isSymptomIdTaken("SYM-999", ...) должен быть false — этот ID нигде не занят');
  if (!isSymptomIdTaken("SYM-094", baseIds, ["SYM-094"])) fail('isSymptomIdTaken("SYM-094", ...) с additionalKnownIds должен быть true, даже если его нет в самом ids.json');
  log("isSymptomIdTaken(): корректно проверяет занятость и в ids.json, и в additionalKnownIds — OK.");

  console.log("\n✅ PASS: test:registry-id-uniqueness");
}

main().catch((err) => fail(String(err?.stack ?? err)));
