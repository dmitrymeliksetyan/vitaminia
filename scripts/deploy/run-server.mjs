#!/usr/bin/env node
// Infrastructure v2 — единая точка запуска Node SSR-сервера, локально
// (`npm run preview`) и на проде (PM2, см. ecosystem.config.cjs).
//
// Зачем отдельный wrapper, а не прямой `node dist/server/entry.mjs`:
//   1. Секреты (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY и т.п. — см.
//      .env.example; после этапа "Выделение AI Worker" здесь больше НЕТ
//      ANTHROPIC_API_KEY/GITHUB_*, это переменные medizin-worker, не сайта)
//      должны попасть в process.env ДО того, как entry.mjs выполнит свой
//      top-level код (он поднимает HTTP-сервер сразу при импорте) —
//      поэтому dotenv грузится первой строкой, до динамического import()
//      энтрипоинта.
//   2. На проде удобно иметь ОДНО место, откуда PM2 стартует процесс, а не
//      размазывать "какой .env файл использовать" по ecosystem.config.cjs.
//   3. Если Astro когда-нибудь переименует entry.mjs/сменит путь — правится
//      только этот файл, не PM2-конфиг и не CI.
//
// Какой .env файл грузится:
//   - NODE_ENV=production (PM2/сервер)         -> .env.production
//   - иначе (локальная разработка/`npm run preview`) -> .env
// Явно указанный ENV_FILE (переменная окружения) имеет приоритет над обоими
// вариантами — удобно для ручной проверки конкретного файла.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProductionEnv } from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

// См. scripts/deploy/load-env.mjs — помимо <repoRoot>/.env.production
// дополнительно проверяет стабильный путь APP_DIR/shared/.env.production,
// независимый от того, создавал ли deploy.sh симлинк секретов именно для
// этого релиза. (medizin-worker — отдельный проект теперь, у него свой
// собственный аналогичный scripts/load-env.mjs, не связанный с этим файлом.)
loadProductionEnv(repoRoot, "run-server");

process.env.HOST = process.env.HOST || "127.0.0.1";
process.env.PORT = process.env.PORT || "4321";

const entryPath = join(repoRoot, "dist", "server", "entry.mjs");
if (!existsSync(entryPath)) {
  console.error(
    `[run-server] Не найден ${entryPath}. Сначала выполните сборку: npm run build (см. scripts/deploy/build.sh).`
  );
  process.exit(1);
}

console.log(`[run-server] Старт Node SSR-сервера на http://${process.env.HOST}:${process.env.PORT}`);
await import(entryPath);
