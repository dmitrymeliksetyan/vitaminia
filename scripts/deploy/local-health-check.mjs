#!/usr/bin/env node
// Infrastructure v2, п.9 ТЗ — быстрый локальный аналог verify.sh's health-часть,
// но без bash/curl, для разработчика: `npm run health:check`.
// Ожидает, что сервер уже запущен (`npm run preview` / `npm run dev` /
// вручную scripts/deploy/run-server.mjs) на HOST:PORT (по умолчанию
// 127.0.0.1:4321, как в run-server.mjs).

const host = process.env.HOST || "127.0.0.1";
const port = process.env.PORT || "4321";
const url = `http://${host}:${port}/health`;

console.log(`[health:check] GET ${url}`);

try {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const res = await fetch(url, { signal: controller.signal });
  clearTimeout(timeout);

  const body = await res.json().catch(() => null);

  if (!res.ok || !body || typeof body.status !== "string") {
    console.error(`[health:check] FAIL: HTTP ${res.status}, тело:`, body);
    process.exit(1);
  }

  console.log(`[health:check] status=${body.status}`);
  console.log(`  node:        ${body.node?.version ?? "?"}`);
  console.log(`  database:    ${body.database?.ok ? "ok" : "FAIL"} (${body.database?.latencyMs ?? "?"}ms)${body.database?.error ? " — " + body.database.error : ""}`);
  console.log(`  git:         ${body.git?.sha ?? "?"} (${body.git?.branch ?? "?"})`);
  console.log(`  build:       v${body.build?.version ?? "?"} (${body.build?.buildTime ?? "?"})`);
  console.log(`  environment: ${body.environment ?? "?"}`);
  console.log(`  uptime:      ${body.uptimeSeconds ?? "?"}s`);

  if (body.status !== "ok") {
    console.error("[health:check] Статус не 'ok' — см. database.error выше");
    process.exit(1);
  }

  console.log("[health:check] OK");
} catch (err) {
  console.error(`[health:check] FAIL: не удалось получить ответ от ${url}`);
  console.error(err instanceof Error ? err.message : err);
  console.error("Сервер запущен? Попробуйте: npm run build && npm run preview");
  process.exit(1);
}
