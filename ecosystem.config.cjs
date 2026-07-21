// Infrastructure v2, п.2-5/п.13-14 ТЗ — конфиг PM2 для Node SSR-процесса
// (только /assistant /my /admin /api /health — см. nginx/vitaminia.conf).
//
// ВАЖНО: cwd указывает на $APP_DIR/current — СИМЛИНК, который атомарно
// переключает scripts/deploy/deploy.sh при каждой публикации (ln -sfn на
// новый releases/<timestamp>/). Именно поэтому `pm2 reload vitaminia-ssr`
// после переключения symlink подхватывает НОВЫЙ релиз без правки этого
// файла и без пересоздания процесса — cwd не меняется, меняется то, на что
// он указывает.
//
// Файл лежит в корне репозитория и деплоится вместе с остальным кодом
// (rsync в build.sh/CI), но реально исполняется PM2 только один раз (при
// самом первом запуске, см. deploy.sh: `pm2 start ecosystem.config.cjs
// --only vitaminia-ssr` как fallback, если процесс ещё не существует)."
//
// APP_DIR должен совпадать со значением в scripts/deploy/config.sh.
const APP_DIR = process.env.APP_DIR || "/var/www/vitaminia";

module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || "vitaminia-ssr",
      script: "scripts/deploy/run-server.mjs",
      cwd: `${APP_DIR}/current`,
      // fork, не cluster: @astrojs/node standalone — обычный однопроцессный
      // HTTP-сервер (не проектировался под shared-port cluster-режим Node.js).
      // Один процесс полностью достаточен для /assistant /my /admin /api —
      // основная нагрузка (SEO-трафик) обслуживается nginx статикой в обход
      // Node целиком. Если нагрузка на Node вырастет, здесь можно перейти на
      // `exec_mode: "cluster"` + `instances: "max"` — @astrojs/node это
      // поддерживает "из коробки" через Node.js cluster API.
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
        ENV_FILE: ".env.production",
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 2000,
      // Логи (п.7 ТЗ, "понятные логи") — отдельно от deploy.log
      // (scripts/deploy/config.sh пишет туда шаги самого деплоя, не
      // рантайм-логи Node-процесса).
      out_file: `${APP_DIR}/shared/logs/pm2-out.log`,
      error_file: `${APP_DIR}/shared/logs/pm2-error.log`,
      merge_logs: true,
      time: true,
      kill_timeout: 5000,
    },
    // Этап "Выделение AI Worker в отдельный независимый сервис" — второй
    // PM2-процесс (vitaminia-worker) УБРАН из этого файла целиком. Очередь
    // производства контента (content_jobs/content_strategy_runs) теперь
    // обслуживается ОТДЕЛЬНЫМ проектом vitaminia-worker, который может жить
    // на совершенно другой машине (США/Канада/Европа/домашний сервер/другой
    // VPS — не имеет значения) и управляется своим собственным
    // ecosystem.config.cjs (см. vitaminia-worker/ecosystem.config.cjs).
    // vitaminia-ssr отсюда никогда не запускает, не останавливает и не
    // перезапускает Worker — единственная связь между ними теперь Supabase,
    // а не PM2 на одном сервере.
  ],
};
