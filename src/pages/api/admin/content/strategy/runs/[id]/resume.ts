import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../../../lib/server/service-role-supabase";
import { markStaleRunningAsInterrupted } from "vitaminia-shared/strategy-run-lifecycle.mjs";

// Этап "Выделение AI Worker в отдельный независимый сервис".
//
// ПЕРЕДЕЛАНО: раньше "Продолжить" синхронно вызывал
// runStrategyStagePipelineGuarded() прямо здесь. Теперь SSR только сбрасывает
// run обратно в status='running' (raw_candidates НЕ трогает — это оплаченный
// чекпоинт, который Worker подхватит и не будет повторно вызывать AI, см.
// strategy-pipeline.ts в medizin-worker) и явно снимает возможный "чужой"
// heartbeat-лок (active_worker_id/active_worker_heartbeat_at из миграции
// 017_worker_separation_flags.sql), чтобы Worker гарантированно смог забрать
// run в следующем же опросе, даже если предыдущий процесс воркера был убит
// не штатно и не успел сам освободить лок.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// 'interrupted' тоже возобновляем — отдельная кнопка "Перезапустить
// исследование" (UI) создаёт НОВЫЙ run вместо попытки чинить старый, а не
// эта проверка.
const RESUMABLE_STATUSES = ["error", "stopped", "running", "interrupted"];

export const POST: APIRoute = async ({ request, locals, params }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const id = params.id;
    if (!id) return json({ ok: false, error: "Не указан ID" }, 200);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data: runRaw, error: runError } = await admin.from("content_strategy_runs").select("*").eq("id", id).single();
    if (runError || !runRaw) return json({ ok: false, error: "Исследование не найдено" }, 200);
    // п.5 ТЗ: "running" старше 10 минут — лениво помечаем "interrupted" ещё
    // до проверки резюмируемости, чтобы клик "Продолжить" на реально
    // зависшем run'е сразу отражал актуальный статус.
    const run = await markStaleRunningAsInterrupted(admin, runRaw);
    if (run.status === "ready" || run.status === "completed") {
      return json({ ok: false, error: `Исследование в статусе "${run.status}" — продолжать не нужно` }, 200);
    }
    if (!RESUMABLE_STATUSES.includes(run.status)) {
      return json({ ok: false, error: `Исследование в статусе "${run.status}" — продолжать нельзя` }, 200);
    }

    // Чистый триггер: возвращаем run в 'running' и снимаем лок — Worker
    // подхватит его в очередном опросе content_strategy_runs.
    await admin
      .from("content_strategy_runs")
      .update({
        status: "running",
        error: null,
        last_raw_response: null,
        active_worker_id: null,
        active_worker_heartbeat_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    const { data: updatedRun } = await admin.from("content_strategy_runs").select("*").eq("id", id).single();
    return json({ ok: true, run: updatedRun });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
