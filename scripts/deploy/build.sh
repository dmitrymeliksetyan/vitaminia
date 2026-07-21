#!/usr/bin/env bash
# Infrastructure v2, п.2/п.7 ТЗ — шаг "build static" пайплайна публикации +
# понятные логи (Build started/finished, Git commit/SHA, Duration).
#
# Запускается ИЛИ в CI (.github/workflows/deploy.yml, на чистом раннере —
# основной путь), ИЛИ вручную прямо на сервере (fallback, если CI недоступен
# — см. DEPLOY.md, "Восстановление после ошибки"). Ничего специфичного для
# конкретной машины здесь нет: npm ci + npm run build — то же самое, что уже
# проверялось локально десятки раз в этом проекте.
#
# Намеренно НЕ трогает /var/www/medizin/releases — раскладкой релизов и
# symlink'ом занимается deploy.sh. build.sh отвечает только за "собрать
# текущий checkout", он же используется CI до rsync на сервер.
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

START_TS=$(date +%s)
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "nogit")"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"

log "Build started (commit=$GIT_SHA branch=$GIT_BRANCH)"

# GITHUB_SHA/GITHUB_REF_NAME — стандартные переменные GitHub Actions,
# прокидываются в generate-build-info.mjs как основной источник (см. п.9/10
# ТЗ, "Версия сайта" — build-info должен знать реальный коммит CI, а не
# только `git rev-parse` локального чекаута раннера).
export GIT_COMMIT_SHA="${GITHUB_SHA:-$GIT_SHA}"
export GIT_BRANCH_NAME="${GITHUB_REF_NAME:-$GIT_BRANCH}"

if [ ! -d node_modules ]; then
  log "node_modules отсутствует — npm ci"
  npm ci --no-audit --no-fund
fi

npm run build

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

if [ ! -f dist/server/entry.mjs ] || [ ! -d dist/client ]; then
  log "Build finished (FAILED): dist/server/entry.mjs или dist/client отсутствуют после сборки"
  exit 1
fi

# Этап "Выделение AI Worker в отдельный независимый сервис" — сборка
# воркера (dist/worker/**) больше НЕ часть сборки сайта: medizin-worker —
# отдельный проект со своим собственным build/deploy (см.
# medizin-worker/scripts/build.mjs, medizin-worker/README.md). Эта проверка
# убрана, сайт больше не знает и не обязан знать про существование
# dist/worker/** вообще.

PAGE_COUNT=$(find dist/client -name "index.html" | wc -l | tr -d ' ')
log "Build finished (OK): commit=$GIT_COMMIT_SHA branch=$GIT_BRANCH_NAME duration=${DURATION}s pages=$PAGE_COUNT"
