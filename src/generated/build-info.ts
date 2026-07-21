// Сгенерировано автоматически (scripts/generate-build-info.mjs) при каждой
// сборке — НЕ редактировать руками, изменения будут перезаписаны следующим
// `npm run dev`/`npm run build`. См. ТЗ "Build Info в админке" и
// Infrastructure v2 (п.9-10 — /health, версия сайта).
export const BUILD_INFO = {
  "version": "20260721.2045",
  "commit": "nogit",
  "branch": "unknown",
  "environment": "local",
  "buildTime": "2026-07-21T20:45:32.668Z",
  "astroVersion": "4.15.0",
  "nodeVersion": "v24.18.0"
} as const;

export type BuildEnvironment = typeof BUILD_INFO.environment;

// Момент запуска ИМЕННО ЭТОГО Node-процесса (не момент сборки) — источник
// для /health "Uptime" (см. src/pages/api/health.ts). Вычисляется один раз
// при первом импорте модуля (модули Node кэшируются — значение стабильно
// на всё время жизни процесса).
export const PROCESS_STARTED_AT = new Date().toISOString();
