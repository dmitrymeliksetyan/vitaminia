#!/usr/bin/env bash
# Infrastructure v2, п.2-4/п.7/п.13 ТЗ — атомарная публикация без даунтайма.
#
# Запускается НА СЕРВЕРЕ после того, как CI (.github/workflows/deploy.yml)
# собрал проект и разложил его в $RELEASES_DIR/<timestamp>/ (rsync: dist/,
# package.json, package-lock.json, scripts/, .github не нужен). Сам git
# commit/push уже произошёл ДО этого — публикацию материала (коммит .mdx +
# content-registry) делает НЕЗАВИСИМЫЙ проект medizin-worker (см.
# src/github/github-client.ts там), не этот сайт; CI триггерится этим пушем.
#
# Последовательность (дословно по п.2 ТЗ, шаги "build static" и "git
# commit/push" уже выполнены до вызова этого скрипта):
#   замена static файлов -> очистка кешей -> проверка публикации -> готово
# "Атомарная публикация" (п.4): новый релиз проверяется НА ОТДЕЛЬНОМ порту
# ДО переключения symlink — если проверка не прошла, старый релиз продолжает
# отдавать трафик, ничего не переключается (zero downtime, п.3).
#
# Использование: scripts/deploy/deploy.sh <release_timestamp>
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

RELEASE_TS="${1:?Использование: deploy.sh <release_timestamp>}"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_TS"
STAGING_PORT="${STAGING_PORT:-4322}"

if [ ! -d "$RELEASE_DIR" ]; then
  log "Deploy failed: релиз $RELEASE_DIR не найден (CI не докатил rsync?)"
  exit 1
fi

DEPLOY_START=$(date +%s)
log "Deploy started: release=$RELEASE_TS"

# --- Секреты релиза: shared/.env.production переживает все релизы, каждый
#     новый релиз получает symlink на него (не копию — один источник правды). ---
if [ -f "$SHARED_DIR/.env.production" ]; then
  ln -sfn "$SHARED_DIR/.env.production" "$RELEASE_DIR/.env.production"
else
  log "ПРЕДУПРЕЖДЕНИЕ: $SHARED_DIR/.env.production не найден — секреты (ANTHROPIC_API_KEY и т.п.) не будут доступны серверу. См. DEPLOY.md, раздел \"Первичная настройка сервера\"."
fi

# --- Продакшн-зависимости для нового релиза (dist/server/entry.mjs их требует в рантайме). ---
log "npm ci --omit=dev в $RELEASE_DIR"
if ! (cd "$RELEASE_DIR" && npm ci --omit=dev --no-audit --no-fund); then
  log "Deploy failed: npm ci --omit=dev не удался — оставляем текущий релиз активным (current не тронут)"
  exit 1
fi

if [ ! -f "$RELEASE_DIR/dist/server/entry.mjs" ] || [ ! -d "$RELEASE_DIR/dist/client" ]; then
  log "Deploy failed: в релизе нет dist/server/entry.mjs или dist/client — build.sh должен был это гарантировать. Оставляем текущий релиз активным."
  exit 1
fi

# --- Проверка нового релиза НА ВРЕМЕННОМ порту, ДО переключения трафика. ---
# Защита от "живым тестом подтверждённой" гонки: если предыдущий деплой
# случился незадолго до этого (частые публикации подряд от medizin-worker),
# его staging-процесс на этом же порту иногда не успевает полностью
# освободить порт к моменту старта следующего деплоя (SIGTERM отправлен, но
# ОС ещё не закрыла сокет) — тогда пробный запуск падает с EADDRINUSE и
# деплой ошибочно проваливается, хотя новый релиз абсолютно рабочий. Здесь
# принудительно освобождаем порт перед стартом — идемпотентно, безопасно
# (порт временный, используется только для staging-проверки одного деплоя
# за раз, ничего кроме предыдущего staging-процесса на нём быть не может).
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${STAGING_PORT}/tcp" 2>/dev/null || true
  sleep 1
fi

log "Пробный запуск нового релиза на порту $STAGING_PORT для проверки перед переключением"
STAGING_PID=""
(
  cd "$RELEASE_DIR" && \
  NODE_ENV=production ENV_FILE=.env.production HOST=127.0.0.1 PORT="$STAGING_PORT" \
  node scripts/deploy/run-server.mjs > "$RELEASE_DIR/staging.log" 2>&1 &
  echo $! > "$RELEASE_DIR/staging.pid"
)
sleep 3
STAGING_PID=$(cat "$RELEASE_DIR/staging.pid" 2>/dev/null || echo "")

STAGING_OK=1
if [ -n "$STAGING_PID" ] && kill -0 "$STAGING_PID" 2>/dev/null; then
  if "$SCRIPT_DIR/verify.sh" "http://127.0.0.1:$STAGING_PORT"; then
    STAGING_OK=0
  fi
else
  log "Deploy failed: пробный процесс не поднялся — см. $RELEASE_DIR/staging.log"
fi

if [ -n "$STAGING_PID" ]; then
  kill "$STAGING_PID" 2>/dev/null || true
  wait "$STAGING_PID" 2>/dev/null || true
fi
rm -f "$RELEASE_DIR/staging.pid"

if [ "$STAGING_OK" -ne 0 ]; then
  log "Deploy failed: проверка нового релиза не прошла (см. verify.sh выше и $RELEASE_DIR/staging.log). Текущий релиз (current) НЕ тронут — сайт продолжает работать на предыдущей версии."
  exit 1
fi

# --- Определяем, изменился ли SSR-бандл (влияет только на "нужен ли restart
#     Node-процесса" — статические файлы подхватываются просто сменой
#     symlink, без какого-либо restart чего-либо). ---
SSR_CHANGED=1
if [ -L "$CURRENT_LINK" ]; then
  PREV_RELEASE="$(readlink -f "$CURRENT_LINK")"
  if [ -d "$PREV_RELEASE/dist/server" ] && command -v sha256sum >/dev/null 2>&1; then
    OLD_HASH=$(find "$PREV_RELEASE/dist/server" -type f -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1)
    NEW_HASH=$(find "$RELEASE_DIR/dist/server" -type f -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1)
    if [ "$OLD_HASH" = "$NEW_HASH" ]; then
      SSR_CHANGED=0
    fi
  fi
fi

# --- Атомарное переключение symlink (ln -sfn — атомарная операция на POSIX,
#     между "было" и "стало" нет промежуточного состояния "нет current"). ---
log "Переключение $CURRENT_LINK -> $RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

if [ "$SSR_CHANGED" -eq 1 ]; then
  log "SSR-бандл изменился — pm2 reload $PM2_APP_NAME (zero-downtime, если cluster mode — см. ecosystem.config.cjs)"
  if command -v pm2 >/dev/null 2>&1; then
    # medizin-ssr работает под pm2 пользователя root (см. DEPLOY.md), а сам
    # деплой выполняется от непривилегированного DEPLOY_USER (deploy) —
    # sudo -n здесь узкий, разрешён sudoers-правилом только на сами команды
    # pm2 (см. настройку сервера), без пароля и без интерактива.
    sudo -n pm2 reload "$PM2_APP_NAME" --update-env || sudo -n pm2 start "$SHARED_DIR/../ecosystem.config.cjs" --only "$PM2_APP_NAME"
  else
    log "ПРЕДУПРЕЖДЕНИЕ: команда pm2 не найдена — Node-процесс не перезапущен автоматически. См. DEPLOY.md."
  fi
else
  log "SSR-бандл не изменился (только статический контент) — PM2 НЕ перезапускается, никакого влияния на текущие соединения Node-процесса"
fi

# --- Этап "Выделение AI Worker в отдельный независимый сервис" — весь блок
#     проверки/перезапуска воркера убран из деплоя сайта. medizin-worker —
#     отдельный проект, который может жить на другом сервере вообще; его
#     деплой/рестарт больше не имеет никакого отношения к деплою medizin-ssr
#     (см. medizin-worker/README.md, раздел "Обновление"). Сайт продолжает
#     работать одинаково независимо от того, задеплоен ли Worker вообще. ---

# --- Очистка кешей (п.2 ТЗ): у nginx здесь нет отдельного application-level
#     кэша перед статикой (root напрямую отдаёт файлы из current/dist/client)
#     — "очистка" сводится к тому, что new symlink уже указывает на новые
#     файлы, кешировать нечего. Если в будущем появится page/proxy cache —
#     единственное место, где его нужно чистить, добавить сюда. ---
log "Очистка кешей: отдельного слоя кэша перед статикой нет — nginx root уже указывает на новые файлы через symlink"

# --- Финальная проверка ЧЕРЕЗ nginx (реальный публичный путь, не localhost:PORT напрямую к Node). ---
sleep 1
if "$SCRIPT_DIR/verify.sh" "$PUBLIC_SITE_URL"; then
  log "Финальная проверка (через nginx, $PUBLIC_SITE_URL) — OK"
else
  log "Финальная проверка (через nginx) НЕ прошла после переключения — откатываемся на предыдущий релиз"
  "$SCRIPT_DIR/rollback.sh" || log "ОШИБКА: автоматический rollback тоже не удался — требуется ручное вмешательство, см. DEPLOY.md"
  exit 1
fi

# --- Закрываем статусы публикации в admin-панели (content_jobs 'deploying'
#     -> 'published') ПРЯМО СЕЙЧАС, а не полагаясь на то, что кто-то откроет
#     нужный экран в браузере — раньше (эпоха Cloudflare Pages) это было
#     единственным механизмом, потому что момент реальной публикации был
#     неизвестен. Теперь мы ЗНАЕМ, что сайт только что успешно обновился
#     (строка выше) — это тот самый момент. Best-effort: сайт уже реально
#     опубликован независимо от исхода этого шага, поэтому ошибка здесь НЕ
#     проваливает весь деплой (см. комментарии в самом скрипте). ---
log "Проверка статусов публикации (content_jobs: deploying -> published)"
NODE_ENV=production ENV_FILE=.env.production node "$RELEASE_DIR/scripts/deploy/resolve-deploying-jobs.mjs" || \
  log "ПРЕДУПРЕЖДЕНИЕ: resolve-deploying-jobs.mjs завершился с ошибкой — не критично для деплоя, но статьи могут остаться в 'deploying' до следующего деплоя или ручной проверки в админке"

# --- Хранить только последние KEEP_RELEASES релизов (для быстрого rollback), остальные удалять. ---
cd "$RELEASES_DIR"
ls -1t | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  log "Удаляю старый релиз: $old"
  rm -rf "${old:?}"
done

DEPLOY_END=$(date +%s)
log "Deploy finished (OK): release=$RELEASE_TS duration=$((DEPLOY_END - DEPLOY_START))s"
