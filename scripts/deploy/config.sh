#!/usr/bin/env bash
# Infrastructure v2 — общие настройки для всех scripts/deploy/*.sh.
# Подключается через `source "$(dirname "$0")/config.sh"` в начале каждого
# скрипта — единственное место, где меняются пути/имена, если структура
# каталогов на сервере отличается от значений по умолчанию ниже.
#
# Все значения можно переопределить переменными окружения (например, в
# .github/workflows/deploy.yml через `env:`, или прямо в shell перед
# запуском скрипта вручную) — ничего не захардкожено без возможности
# override.

# Корневой каталог на сервере, где живут все релизы этого сайта.
# Структура (по мотивам стандартного capistrano-style zero-downtime deploy):
#   $APP_DIR/releases/<timestamp>/   — один полный checkout+build на релиз
#   $APP_DIR/current                 — symlink на активный releases/<timestamp>
#   $APP_DIR/shared/.env.production  — секреты, НЕ часть релиза, персистентны
#   $APP_DIR/shared/logs/            — логи PM2 (см. ecosystem.config.cjs)
APP_DIR="${APP_DIR:-/var/www/vitaminia}"
RELEASES_DIR="${RELEASES_DIR:-$APP_DIR/releases}"
CURRENT_LINK="${CURRENT_LINK:-$APP_DIR/current}"
SHARED_DIR="${SHARED_DIR:-$APP_DIR/shared}"

# Сколько старых релизов хранить (для быстрого rollback) — остальные
# scripts/deploy/build.sh чистит после успешного деплоя.
KEEP_RELEASES="${KEEP_RELEASES:-5}"

# Имя процесса в PM2 (см. ecosystem.config.cjs) — используется deploy.sh/
# rollback.sh для reload/restart именно этого процесса, не всех сразу.
PM2_APP_NAME="${PM2_APP_NAME:-vitaminia-ssr}"

# Этап "Выделение AI Worker в отдельный независимый сервис" — PM2_WORKER_NAME
# и весь связанный с ним рестарт-код УБРАНЫ из деплоя сайта. medizin-worker —
# теперь полностью отдельный проект/деплой/сервер (см. medizin-worker/README.md),
# deploy.sh сайта его больше не запускает, не перезапускает и не проверяет.

# Адрес, на котором Node-сервер слушает локально (nginx проксирует сюда же —
# см. nginx/medizin.conf). Используется verify.sh для локальных проверок
# перед тем, как переключать трафик на новый релиз.
NODE_HOST="${NODE_HOST:-127.0.0.1}"
NODE_PORT="${NODE_PORT:-4321}"

# Публичный URL сайта — verify.sh проверяет им реальную, "внешнюю" точку
# входа (через nginx), а не только localhost:PORT напрямую к Node.
PUBLIC_SITE_URL="${PUBLIC_SITE_URL:-https://vitaminia.medizin.ru}"

# Единый формат лога — секунды с начала эпохи + ISO-время, см. п.7 ТЗ
# ("понятные логи... Build started/finished, Deploy started/finished, Git
# commit, Git SHA, Duration").
log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
}
