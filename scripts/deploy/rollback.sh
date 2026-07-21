#!/usr/bin/env bash
# Infrastructure v2, п.14 ТЗ — "быстро вернуть предыдущую версию сайта".
#
# Использование:
#   scripts/deploy/rollback.sh              — откат на релиз, который был
#                                              активен ПЕРЕД текущим
#                                              (по времени модификации
#                                              каталогов в $RELEASES_DIR)
#   scripts/deploy/rollback.sh <timestamp>  — откат на конкретный релиз
#
# Вызывается ЛИБО автоматически из deploy.sh (если финальная проверка после
# переключения не прошла), ЛИБО вручную администратором (`npm run
# deploy:rollback` — см. package.json) при любой другой причине "откатить".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

TARGET_TS="${1:-}"

if [ -z "$TARGET_TS" ]; then
  CURRENT_REAL="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")"
  CURRENT_NAME="$(basename "$CURRENT_REAL" 2>/dev/null || echo "")"
  # Второй по свежести релиз (первый — тот, что активен сейчас).
  TARGET_TS=$(cd "$RELEASES_DIR" && ls -1t | grep -v "^${CURRENT_NAME}\$" | head -n 1 || echo "")
fi

if [ -z "$TARGET_TS" ]; then
  log "Rollback failed: не удалось определить предыдущий релиз (нет второго релиза в $RELEASES_DIR?)"
  exit 1
fi

TARGET_DIR="$RELEASES_DIR/$TARGET_TS"
if [ ! -d "$TARGET_DIR" ]; then
  log "Rollback failed: релиз $TARGET_DIR не существует"
  exit 1
fi

ROLLBACK_START=$(date +%s)
log "Rollback started: target=$TARGET_TS"

ln -sfn "$TARGET_DIR" "$CURRENT_LINK"

if command -v pm2 >/dev/null 2>&1; then
  # См. комментарий в deploy.sh — medizin-ssr работает под pm2 пользователя
  # root, деплой выполняется от DEPLOY_USER (deploy), sudo -n узко разрешён
  # sudoers-правилом только на pm2.
  sudo -n pm2 reload "$PM2_APP_NAME" --update-env || sudo -n pm2 restart "$PM2_APP_NAME" || true
  # Этап "Выделение AI Worker в отдельный независимый сервис" — medizin-worker
  # больше НЕ откатывается вместе с сайтом: это отдельный проект на отдельном
  # деплое (возможно, на другом сервере вообще), у него свой rollback (см.
  # medizin-worker/README.md, раздел "Откат"). Откат SSR никак не касается
  # Worker — они общаются только через Supabase, не через общий релиз.
else
  log "ПРЕДУПРЕЖДЕНИЕ: pm2 не найден — перезапустите Node-процесс medizin-ssr вручную"
fi

sleep 1
if "$SCRIPT_DIR/verify.sh" "$PUBLIC_SITE_URL"; then
  log "Rollback finished (OK): target=$TARGET_TS duration=$(( $(date +%s) - ROLLBACK_START ))s"
else
  log "Rollback finished, НО проверка после отката не прошла — нужна ручная диагностика (см. DEPLOY.md, \"Восстановление после ошибки\")"
  exit 1
fi
