import type { APIRoute } from "astro";
import { BUILD_INFO, PROCESS_STARTED_AT } from "../generated/build-info";
import { getRuntimeEnv } from "../lib/assistant/runtime-env";

// Infrastructure v2, п.9 ТЗ — "/health, показывает Node/Database/Git SHA/
// Build version/Environment/Uptime". Используется:
//   - scripts/deploy/verify.sh (проверка публикации, п.8 ТЗ) — эндпоинт
//     должен реально уметь ответить, а не просто существовать статически;
//   - вручную/мониторингом для быстрой диагностики "что сейчас крутится на
//     проде" без захода на сервер по SSH.
//
// НАМЕРЕННО лежит по корневому пути /health, а не /api/health — так требует
// ТЗ дословно ("добавить /health-страницу"). Единственное следствие: в
// nginx-конфиге (см. nginx/medizin.conf, п.5-6 ТЗ) для /health добавлен
// ОДИН точечный `location = /health`, проксируемый в Node — в дополнение к
// префиксам /assistant /my /admin /api из ТЗ. Это не нарушает дух п.5
// ("Node отдаёт только эти разделы") — /health не является SEO-страницей,
// не индексируется и физически не может быть отдан статикой (в отличие от
// prerender-страниц, ему нужен живой Node-процесс: Uptime и статус БД
// вычисляются в момент запроса, а не во время сборки).
//
// Намеренно НЕ требует авторизации (в отличие от /admin/*) — health-check
// эндпоинты по конвенции публичны (так их может дёргать внешний
// мониторинг/uptime-робот без секретов), но не отдаёт ничего секретного:
// только имя окружения/версию/статус БД (ok/not ok, без деталей подключения).
export const prerender = false;

// Быстрый ping Supabase PostgREST через анонимный ключ (PUBLIC_*, не
// секрет) — проверяем именно "база физически отвечает", а не бизнес-данные,
// поэтому не нужен service-role и не нужна конкретная таблица (устойчиво к
// будущим изменениям схемы). Таймаут короткий — health-check сам должен
// быть быстрым, никогда не зависать из-за медленной сети до Supabase.
const DB_PING_TIMEOUT_MS = 2000;

async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const url = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) {
    return { ok: false, latencyMs: 0, error: "PUBLIC_SUPABASE_URL/PUBLIC_SUPABASE_ANON_KEY не заданы" };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DB_PING_TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
      headers: { apikey: anonKey },
      signal: controller.signal,
    });
    // PostgREST root отвечает 200 (OpenAPI-спека) если сервис жив — сам факт
    // получения HTTP-ответа (даже не 200, кроме сетевых ошибок/таймаута)
    // уже означает "база физически достижима". 401/404 тоже "жива", просто
    // неверные права/путь — поэтому проверяем именно res.status < 500.
    return { ok: res.status < 500, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const GET: APIRoute = async ({ locals }) => {
  const env = getRuntimeEnv(locals);
  const database = await checkDatabase();

  const uptimeSeconds = Math.round((Date.now() - new Date(PROCESS_STARTED_AT).getTime()) / 1000);

  const status = database.ok ? "ok" : "degraded";

  return new Response(
    JSON.stringify(
      {
        status,
        node: {
          ok: true,
          version: process.version,
        },
        database,
        git: {
          sha: BUILD_INFO.commit,
          branch: BUILD_INFO.branch,
        },
        build: {
          version: BUILD_INFO.version,
          buildTime: BUILD_INFO.buildTime,
        },
        environment: BUILD_INFO.environment,
        uptimeSeconds,
        // Диагностика для ping.ts-подобных случаев — виден ли вообще
        // ANTHROPIC_API_KEY серверному процессу (без значения, только флаг),
        // не требует отдельного похода на /api/assistant/ping для базовой
        // проверки "секреты вообще настроены".
        assistantConfigured: Boolean(env.ANTHROPIC_API_KEY),
      },
      null,
      2
    ),
    {
      status: status === "ok" ? 200 : 200, // health-check сам жив в обоих случаях — деградация видна в теле, не в HTTP-статусе
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }
  );
};
