/**
 * Завершение зависших запусков AI-стратега — "Статус running старше 10 минут
 * автоматически считать interrupted, чтобы он не висел бесконечно."
 *
 * Раньше жил как src/lib/content-editor/stages/strategy-run-lifecycle.ts
 * внутри medizin. После разделения на medizin (SSR) / medizin-worker нужен
 * ОБЕИМ сторонам:
 *   - medizin вызывает его при любом чтении run'а для показа администратору
 *     (GET /api/admin/content/strategy/runs, /runs/[id]) — так зависший run
 *     гарантированно получает ярлык "interrupted" при следующем обращении,
 *     кто бы его ни сделал;
 *   - medizin-worker вызывает его же как собственный safety-net перед тем,
 *     как забрать run в работу (защита от повторного захвата зависшего own
 *     run той же логикой, что видит и админка).
 *
 * Перенесено в общий пакет medizin-shared (plain ESM, без TS) — единственная
 * реализация вместо двух копий одной и той же проверки.
 */

export const STALE_RUNNING_MS = 10 * 60 * 1000;

export function isStaleRunning(run) {
  if (run.status !== "running") return false;
  const updatedAtMs = new Date(run.updated_at).getTime();
  if (!Number.isFinite(updatedAtMs)) return false;
  return Date.now() - updatedAtMs > STALE_RUNNING_MS;
}

/**
 * Если run завис в 'running' дольше 10 минут — переводит его в 'interrupted'
 * в БД и возвращает уже обновлённый объект (чтобы вызывающий код сразу
 * показал актуальный статус, не делая второй SELECT). Если run не завис —
 * возвращает его без изменений.
 */
export async function markStaleRunningAsInterrupted(admin, run) {
  if (!isStaleRunning(run)) return run;

  const message = `Запуск завис в статусе "running" дольше 10 минут (последнее обновление: ${run.updated_at}) — автоматически помечен как прерванный. Нажмите «Продолжить», чтобы возобновить, или «Перезапустить исследование», чтобы начать заново.`;
  const patch = {
    status: "interrupted",
    error: message,
    last_error: message,
    updated_at: new Date().toISOString(),
  };
  await admin.from("content_strategy_runs").update(patch).eq("id", run.id);
  return { ...run, ...patch };
}

/** Пакетная версия для списков истории (GET /runs) — по одному UPDATE на зависший run, без лишних round-trip'ов на здоровые. */
export async function markStaleRunningInList(admin, runs) {
  const result = [];
  for (const run of runs) {
    result.push(await markStaleRunningAsInterrupted(admin, run));
  }
  return result;
}
