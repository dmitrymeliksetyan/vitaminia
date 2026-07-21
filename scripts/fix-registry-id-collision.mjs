#!/usr/bin/env node
// Одноразовый скрипт-ремедиация критического бага генерации Registry ID.
//
// Живые данные (Supabase content_jobs) на момент диагностики показали
// SYM-094 одновременно закреплённым за ЧЕТЫРЬМЯ разными материалами:
//   lor/ikota                              (Икота — опубликован первым, ID остаётся)
//   general/onemenie-paltsev-ruk           (Онемение пальцев рук)
//   general/cheshetsya-v-boku              (Что-то чешется в боку)
//   mens-health/bystroe-semyaizverzhenie   (Быстрое семяизвержение)
// SYM-095 уже корректно закреплён за skin/pokrasnenie-kozhi (не трогаем).
//
// Этот скрипт ОДИН РАЗ приводит src/data/content-registry.ids.json в живом
// репозитории к правильному состоянию:
//   lor/ikota                              → SYM-094 (остаётся, опубликован раньше всех)
//   skin/pokrasnenie-kozhi                 → SYM-095 (остаётся, уже верно)
//   general/onemenie-paltsev-ruk           → SYM-096 (новый)
//   general/cheshetsya-v-boku              → SYM-097 (новый)
//   mens-health/bystroe-semyaizverzhenie   → SYM-098 (новый)
//
// Использует ТЕ ЖЕ функции, что и боевой код (github-client.ts,
// registry-publish.ts) — никакой отдельной, потенциально расходящейся
// логики. По умолчанию — DRY RUN (только показывает, что изменится). Чтобы
// реально закоммитить исправление, запустите с флагом --commit.
//
// Требует переменные окружения (те же, что и продовые секреты):
//   GITHUB_TOKEN, GITHUB_REPO ("owner/repo"), GITHUB_BRANCH (по умолчанию "main")
//
// Запуск:
//   GITHUB_TOKEN=... GITHUB_REPO=owner/repo node scripts/fix-registry-id-collision.mjs
//   GITHUB_TOKEN=... GITHUB_REPO=owner/repo node scripts/fix-registry-id-collision.mjs --commit

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const IDS_PATH = "src/data/content-registry.ids.json";

const COMMIT = process.argv.includes("--commit");

// Итоговое, ПРАВИЛЬНОЕ состояние для пяти затронутых материалов (см. заголовок).
// Порядок здесь — только для читаемости лога, на итоговый JSON не влияет.
const CORRECT_ASSIGNMENTS = [
  { key: "lor/ikota", id: "SYM-094", title: "Икота" },
  { key: "skin/pokrasnenie-kozhi", id: "SYM-095", title: "Покраснение кожи" },
  { key: "general/onemenie-paltsev-ruk", id: "SYM-096", title: "Онемение пальцев рук" },
  { key: "general/cheshetsya-v-boku", id: "SYM-097", title: "Что-то чешется в боку" },
  { key: "mens-health/bystroe-semyaizverzhenie", id: "SYM-098", title: "Быстрое семяизвержение" },
];

function log(msg) {
  console.log(`[fix-registry-id-collision] ${msg}`);
}
function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function loadGithubClient() {
  const bundlePath = join(repoRoot, ".tmp-github-client-bundle.mjs");
  await esbuild.build({
    entryPoints: [join(repoRoot, "src/lib/content-editor/github-client.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundlePath,
  });
  const mod = await import(`file://${bundlePath}`);
  rmSync(bundlePath, { force: true });
  return mod;
}

async function main() {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repoFull = process.env.GITHUB_REPO?.trim();
  const branch = process.env.GITHUB_BRANCH?.trim() || "main";
  if (!token || !repoFull || !repoFull.includes("/")) {
    fail("Не заданы GITHUB_TOKEN/GITHUB_REPO. Пример запуска:\n  GITHUB_TOKEN=ghp_xxx GITHUB_REPO=owner/repo node scripts/fix-registry-id-collision.mjs");
  }
  const [owner, repo] = repoFull.split("/");
  const env = { token, owner, repo, branch };

  const { getFileContent, commitFilesAtomic } = await loadGithubClient();

  log(`Читаю ${IDS_PATH} из ${owner}/${repo}@${branch}…`);
  const file = await getFileContent(env, IDS_PATH);
  if (!file.ok) fail(`Не удалось прочитать файл: ${file.error}`);
  if (file.content === null) fail(`Файл ${IDS_PATH} не найден в репозитории — нечего исправлять.`);

  let arr;
  try {
    arr = JSON.parse(file.content);
  } catch (err) {
    fail(`Не удалось разобрать ${IDS_PATH} как JSON: ${err}`);
  }
  if (!Array.isArray(arr)) fail(`${IDS_PATH} должен быть JSON-массивом`);

  log(`Прочитано ${arr.length} записей.`);

  // --- Диагностика текущего состояния (для честного лога, что реально было). ---
  const byId = new Map();
  for (const e of arr) {
    if (e.type !== "symptom") continue;
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e.key);
  }
  for (const [id, keys] of byId) {
    if (keys.length > 1) log(`  ⚠ ОБНАРУЖЕН дубль ID ${id}: ${keys.join(", ")}`);
  }

  // --- Реконциляция: убираем ЛЮБЫЕ существующие записи, совпадающие ПО КЛЮЧУ
  // с одним из пяти известных материалов (независимо от того, какой ID там
  // сейчас стоит — мог быть неправильным/дублирующим), затем добавляем
  // ровно ОДНУ корректную запись на каждый. ---
  const knownKeys = new Set(CORRECT_ASSIGNMENTS.map((a) => a.key));
  const withoutKnown = arr.filter((e) => !(e.type === "symptom" && knownKeys.has(e.key)));

  const removedCount = arr.length - withoutKnown.length;
  log(`Удаляю ${removedCount} существующих (возможно, некорректных) записей для пяти известных материалов — будут добавлены заново с правильными ID.`);

  const fixed = [
    ...withoutKnown,
    ...CORRECT_ASSIGNMENTS.map((a) => ({ id: a.id, type: "symptom", key: a.key })),
  ];

  // --- Финальная проверка: среди symptom-записей больше НЕТ дублирующихся ID. ---
  const finalById = new Map();
  let hasDuplicates = false;
  for (const e of fixed) {
    if (e.type !== "symptom") continue;
    if (finalById.has(e.id)) {
      hasDuplicates = true;
      log(`  ❌ ПОСЛЕ исправления дубль всё ещё есть: ${e.id} — ${finalById.get(e.id)} и ${e.key}`);
    }
    finalById.set(e.id, e.key);
  }
  if (hasDuplicates) fail("После реконциляции дубли ID всё ещё присутствуют — остановлено, ничего не закоммичено.");

  log("\nИтоговое сопоставление для пяти материалов:");
  for (const a of CORRECT_ASSIGNMENTS) log(`  ${a.id}  →  ${a.key}  (${a.title})`);

  const newText = JSON.stringify(fixed, null, 2) + "\n";

  if (!COMMIT) {
    log("\nDRY RUN — ничего не закоммичено. Запустите с флагом --commit, чтобы применить исправление.");
    return;
  }

  log("\nКоммичу исправленный файл…");
  const commitMessage = "content: исправить дубль Registry ID SYM-094 (Икота/Онемение пальцев рук/Что-то чешется в боку/Быстрое семяизвержение)\n\nАвтоматическая ремедиация: SYM-094 остаётся за Икотой (опубликован первым), остальным материалам присвоены новые уникальные ID (SYM-096, SYM-097, SYM-098).";
  const commitRes = await commitFilesAtomic(env, [{ path: IDS_PATH, content: newText }], commitMessage);
  if (!commitRes.ok) fail(`Коммит не удался на этапе "${commitRes.stage}": ${commitRes.error}`);

  log(`✅ Готово. Commit SHA: ${commitRes.commitSha}`);
  log("Не забудьте также обновить content_jobs.publish_registry_id в Supabase для затронутых задач (если это не сделано отдельно).");
}

main().catch((err) => fail(String(err?.stack ?? err)));
