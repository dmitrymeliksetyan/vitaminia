#!/usr/bin/env node
// Единая надёжная загрузка секретов для Node-процесса SSR, запускаемого PM2
// (medizin-ssr) — scripts/deploy/run-server.mjs подключает этот модуль
// ПЕРВОЙ строкой, до всего остального кода (в т.ч. до динамического
// import() энтрипоинта). (medizin-worker — отдельный проект с момента этапа
// "Выделение AI Worker в отдельный независимый сервис", у него собственный
// одноимённый scripts/load-env.mjs — не этот файл, копия по той же схеме.)
//
// РЕАЛЬНЫЙ ИНЦИДЕНТ, из-за которого появился этот файл: раньше оба
// wrapper-скрипта искали .env.production ТОЛЬКО внутри своего же релиза
// (`<repoRoot>/.env.production`, где repoRoot вычислялся от расположения
// самого скрипта) — а туда его кладёт СИМЛИНКОМ именно
// scripts/deploy/deploy.sh (шаг "Секреты релиза": `ln -sfn
// $SHARED_DIR/.env.production $RELEASE_DIR/.env.production`).
//
// Если процесс запущен В ОБХОД deploy.sh — например, самый первый `pm2
// start ecosystem.config.cjs --only medizin-worker` при добавлении НОВОГО
// PM2-приложения, для которого полный деплой ещё ни разу не прогонялся, —
// этот симлинк физически не существует, .env.production "не находится", и
// секреты (SUPABASE_SERVICE_ROLE_KEY и т.п.) просто отсутствуют в
// process.env. Раньше это молча маскировалось, ЕСЛИ администратор перед
// стартом PM2 вручную выполнял `source .env.production` в том же
// SSH-сеансе — PM2 daemon/форк наследовал уже проставленные переменные
// окружения родительского шелла. Без этого ручного шага — тихий сбой без
// понятной причины в логах (только "SUPABASE_SERVICE_ROLE_KEY не задан").
//
// РЕШЕНИЕ: ищем .env.production в НЕСКОЛЬКИХ местах по приоритету, включая
// СТАБИЛЬНЫЙ абсолютный путь shared/.env.production — тот, что реально
// переживает все релизы и НЕ зависит от того, прогонялся ли deploy.sh для
// ЭТОГО конкретного релиза/процесса. Именно это и убирает необходимость в
// ручном `source` перед запуском PM2.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * Загружает переменные окружения из первого найденного файла-кандидата и
 * возвращает его путь (или null, если ни один не найден — тогда процесс
 * работает с уже имеющимся process.env, например заданным PM2/systemd
 * напрямую, что тоже валидный сценарий и не является ошибкой само по себе).
 *
 * @param {string} repoRoot - корень текущего релиза/чекаута (там, откуда
 *   реально запущен сам процесс — `${APP_DIR}/current` в проде).
 * @param {string} label - префикс для логов, например "run-server"/"run-worker".
 */
export function loadProductionEnv(repoRoot, label) {
  const explicitEnvFile = process.env.ENV_FILE;
  const defaultEnvFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env";
  const envFileName = explicitEnvFile || defaultEnvFile;
  const appDir = process.env.APP_DIR || "/var/www/medizin";

  // Порядок попыток (побеждает первый РЕАЛЬНО существующий файл):
  //   1) ENV_FILE, если задан АБСОЛЮТНЫМ путём — явное намерение
  //      администратора, наивысший приоритет, ничего не угадываем;
  //   2) <repoRoot>/<envFileName> — обычный случай, когда deploy.sh уже
  //      создал симлинк секретов именно в этом релизе;
  //   3) <APP_DIR>/shared/<envFileName> — СТАБИЛЬНЫЙ путь, НЕ зависящий от
  //      того, существует ли релиз-специфичный симлинк — основная защита
  //      от инцидента, описанного в шапке файла.
  const candidates = [];
  if (explicitEnvFile && isAbsolute(explicitEnvFile)) candidates.push(explicitEnvFile);
  candidates.push(join(repoRoot, envFileName));
  candidates.push(join(appDir, "shared", envFileName));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      // override:false (поведение dotenv по умолчанию) — если переменная уже
      // задана напрямую в окружении PM2/systemd, файл её не перезатирает.
      loadDotenv({ path: candidate, override: false });
      console.log(`[${label}] Загружен ${candidate}`);
      return candidate;
    }
  }

  console.warn(
    `[${label}] Не найден ни один из ожидаемых файлов секретов (проверено: ${candidates.join(", ")}) — процесс стартует с уже имеющимся process.env (например, переменные заданы PM2/systemd напрямую, либо секреты отсутствуют вовсе — это будет видно по дальнейшим ошибкам конкретных проверок обязательных переменных).`
  );
  return null;
}
