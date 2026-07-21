#!/usr/bin/env node
// ТЗ "Build Info в админке" (+ Infrastructure v2, п.9-10 — /health и
// "полноценная версия сайта") — на КАЖДОЙ сборке (`npm run dev` через
// predev, `npm run build` первым шагом) автоматически генерирует
// src/generated/build-info.ts с версией/коммитом/веткой/окружением/временем
// сборки. Файл НЕ коммитится в git (см. .gitignore — src/generated/) и не
// редактируется руками: коммит-до-сборки был бы невозможен (сборка не может
// заранее знать хэш коммита, которым она сама станет), поэтому единственный
// корректный подход — генерировать заново при каждой сборке, локально и в
// CI одинаково.
//
// Версия (п. ТЗ "Version"): вместо ручного semver-инкремента (нужен был бы
// персистентный счётчик — в эфемерном CI-окружении негде надёжно хранить
// его между запусками) используется схема по дате, явно разрешённая ТЗ как
// альтернатива: YYYYMMDD.HHmm — растёт строго монотонно и гарантированно
// уникальна на сборку (коллизия возможна только при двух сборках в одну и
// ту же минуту, что на практике не происходит).
//
// Commit/branch/environment: проект полностью переехал с Cloudflare Pages
// на GitHub Actions CI + собственный VPS (см. DEPLOY.md) — Cloudflare Pages
// и Workers больше нигде не используются, поэтому легаси CF_PAGES_*-фолбэк
// (существовавший здесь во время переходного периода) удалён целиком, а не
// оставлен "на всякий случай". Приоритет источников commit/branch:
//   1. GIT_COMMIT_SHA/GIT_BRANCH_NAME — явно прокинуты scripts/deploy/build.sh
//      (тот сам берёт GITHUB_SHA/GITHUB_REF_NAME в CI или git rev-parse
//      локально) — самый надёжный источник, если сборка идёт через build.sh.
//   2. GITHUB_SHA/GITHUB_REF_NAME/GITHUB_ACTIONS напрямую — на случай, если
//      generate-build-info.mjs вызван внутри GitHub Actions в обход build.sh.
//   3. `git rev-parse` — запасной путь для локальной сборки
//      (`npm run dev`/`npm run build` на машине разработчика).

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const outPath = join(repoRoot, "src/generated/build-info.ts");

function tryGit(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// --- Версия: YYYYMMDD.HHmm (UTC), см. заголовок файла. ---
const now = new Date();
const version = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}.${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;

// --- Commit: см. приоритет источников в заголовке файла. ---
const rawCommit =
  process.env.GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  tryGit(["rev-parse", "HEAD"]);
const commit = rawCommit ? rawCommit.slice(0, 7) : "nogit";

// --- Branch: аналогично. ---
const branch =
  process.env.GIT_BRANCH_NAME ??
  process.env.GITHUB_REF_NAME ??
  tryGit(["rev-parse", "--abbrev-ref", "HEAD"]) ??
  "unknown";

// --- Environment: без признаков CI (GITHUB_ACTIONS) в build-окружении —
// это точно локальная сборка (npm run dev / npm run build на машине
// разработчика). В CI — "production", если ветка совпадает с
// production-веткой проекта (по умолчанию "main", переопределяется
// переменной окружения PROD_BRANCH при необходимости), иначе "preview".
const prodBranch = process.env.PROD_BRANCH ?? "main";
const inCi = process.env.GITHUB_ACTIONS === "true";
let environment;
if (!inCi) {
  environment = "local";
} else if (branch === prodBranch) {
  environment = "production";
} else {
  environment = "preview";
}

// --- Astro/Node версии для модального окна с подробностями. ---
let astroVersion = "unknown";
try {
  astroVersion = JSON.parse(readFileSync(join(repoRoot, "node_modules/astro/package.json"), "utf-8")).version;
} catch {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    astroVersion = (pkg.dependencies?.astro ?? "unknown").replace(/^[\^~]/, "");
  } catch {
    // оставляем "unknown"
  }
}
const nodeVersion = process.version;

const buildInfo = {
  version,
  commit,
  branch,
  environment,
  buildTime: now.toISOString(),
  astroVersion,
  nodeVersion,
};

const ts = `// Сгенерировано автоматически (scripts/generate-build-info.mjs) при каждой
// сборке — НЕ редактировать руками, изменения будут перезаписаны следующим
// \`npm run dev\`/\`npm run build\`. См. ТЗ "Build Info в админке" и
// Infrastructure v2 (п.9-10 — /health, версия сайта).
export const BUILD_INFO = ${JSON.stringify(buildInfo, null, 2)} as const;

export type BuildEnvironment = typeof BUILD_INFO.environment;

// Момент запуска ИМЕННО ЭТОГО Node-процесса (не момент сборки) — источник
// для /health "Uptime" (см. src/pages/api/health.ts). Вычисляется один раз
// при первом импорте модуля (модули Node кэшируются — значение стабильно
// на всё время жизни процесса).
export const PROCESS_STARTED_AT = new Date().toISOString();
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, ts, "utf-8");
console.log(`build-info.ts generated: v${version} • ${commit} • ${branch} • ${environment}`);
