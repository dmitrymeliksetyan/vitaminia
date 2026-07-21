#!/usr/bin/env node
// Infrastructure v2 — закрывает последний реальный "хвост" зависимости от
// Cloudflare Pages в публикационном пайплайне.
//
// Контекст: src/pages/api/admin/content/jobs/[id]/decision.ts после
// успешного git-коммита ставит статус job'а 'deploying', НЕ 'published' —
// это осталось от эпохи Cloudflare Pages, когда сборка/деплой были
// асинхронным чёрным ящиком (пуш → когда-то потом Cloudflare сама соберёт
// сайт, без возможности узнать когда именно). Переход 'deploying' ->
// 'published' (см. src/pages/api/admin/content/jobs/[id]/check-deploy.ts)
// раньше происходил ТОЛЬКО если админ открывал экран этого job'а в
// браузере — там есть клиентский поллинг (EditorialApp.tsx), который дёргал
// check-deploy каждые несколько секунд, пока вкладка открыта. Если админ не
// сидел на экране — job мог годами висеть в "deploying", хотя статья давно
// реально на сайте.
//
// Теперь деплой синхронный и детерминированный: scripts/deploy/deploy.sh
// точно знает момент, когда сайт реально обновился (публичная проверка
// verify.sh уже прошла). Поэтому этот скрипт запускается ПОСЛЕДНИМ шагом
// deploy.sh, СРАЗУ после успешной публичной проверки — закрывает статусы
// БЕЗ какого-либо открытого браузера, полностью автоматически. Клиентский
// поллинг в EditorialApp.tsx оставлен как есть (защитный дубль на случай,
// если этот скрипт по какой-то причине не отработал) — не убирать.
//
// Логика проверки "жива ли страница" ЗЕРКАЛИТ check-deploy.ts (fetch
// publish_expected_url, res.ok && html содержит title) — если когда-нибудь
// будете менять эту логику, поменяйте в обоих местах.
//
// Использование: node scripts/deploy/resolve-deploying-jobs.mjs
// (запускается из deploy.sh на сервере, из корня релиза; сам грузит
// .env.production так же, как run-server.mjs)

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const explicitEnvFile = process.env.ENV_FILE;
const defaultEnvFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env";
const envPath = join(repoRoot, explicitEnvFile || defaultEnvFile);
if (existsSync(envPath)) {
  loadDotenv({ path: envPath });
}

const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.warn(
    "[resolve-deploying-jobs] PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY не заданы — пропускаю (job'ы останутся в 'deploying', клиентский поллинг в админке всё ещё сработает)."
  );
  process.exit(0); // не проваливаем весь deploy.sh из-за этого — сайт уже реально опубликован
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const FETCH_TIMEOUT_MS = 8000;

async function checkLive(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) return { live: false, note: `HTTP ${res.status}` };
    return { live: true, html: await res.text() };
  } catch (err) {
    return { live: false, note: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const { data: jobs, error } = await supabase
    .from("content_jobs")
    .select("id, draft, publish_expected_url, content_type")
    .eq("status", "deploying");

  if (error) {
    console.warn(`[resolve-deploying-jobs] Не удалось прочитать content_jobs: ${error.message}`);
    process.exit(0);
    return;
  }

  if (!jobs || jobs.length === 0) {
    console.log("[resolve-deploying-jobs] Нет job'ов в статусе 'deploying' — нечего проверять.");
    return;
  }

  console.log(`[resolve-deploying-jobs] Проверяю ${jobs.length} job(ов) в статусе 'deploying'...`);

  let resolved = 0;
  for (const job of jobs) {
    const url = job.publish_expected_url;
    if (!url) {
      console.warn(`[resolve-deploying-jobs] job ${job.id}: нет publish_expected_url — пропускаю`);
      continue;
    }
    // Раздел «Лекарства» — заголовок материала лежит в genericName, не в
    // title (см. тот же фикс в check-deploy.ts, это зеркальная логика).
    const fm = job.draft?.frontmatter ?? {};
    const title = job.content_type === "drug"
      ? (typeof fm.genericName === "string" ? fm.genericName : "")
      : (typeof fm.title === "string" ? fm.title : "");
    const result = await checkLive(url);

    if (result.live && title && result.html.includes(title)) {
      const { error: updateError } = await supabase
        .from("content_jobs")
        .update({
          status: "published",
          published_at: new Date().toISOString(),
          deploy_checked_at: new Date().toISOString(),
          deploy_check_note: `Автоматически подтверждено сразу после деплоя (resolve-deploying-jobs.mjs): ${url} отвечает 200 и содержит заголовок материала.`,
          deploy_url_live: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      if (updateError) {
        console.warn(`[resolve-deploying-jobs] job ${job.id}: страница жива, но не удалось обновить статус: ${updateError.message}`);
      } else {
        resolved += 1;
        console.log(`[resolve-deploying-jobs] job ${job.id}: OK -> published (${url})`);
      }
    } else {
      const reason = result.live ? "страница отвечает, но заголовок не найден (возможно, кэш/CDN)" : result.note;
      console.log(`[resolve-deploying-jobs] job ${job.id}: ещё не подтверждено (${reason}) — оставляю 'deploying', попробую на следующем деплое`);
    }
  }

  console.log(`[resolve-deploying-jobs] Готово: ${resolved} из ${jobs.length} переведено в 'published'.`);
}

main().catch((err) => {
  // Намеренно НЕ process.exit(1) — сбой этого скрипта не должен считаться
  // сбоем всего deploy.sh (сайт уже реально опубликован к этому моменту,
  // это только про статус в admin-панели).
  console.warn(`[resolve-deploying-jobs] Неожиданная ошибка: ${err instanceof Error ? err.message : String(err)}`);
});
