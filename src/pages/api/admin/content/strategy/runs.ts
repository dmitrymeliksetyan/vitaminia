import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../lib/server/service-role-supabase";
import { markStaleRunningInList } from "vitaminia-shared/strategy-run-lifecycle.mjs";

// Этап "Выделение AI Worker в отдельный независимый сервис".
//
// ПЕРЕДЕЛАНО: POST раньше синхронно вызывал runStrategyStagePipelineGuarded()
// (контекст → AI-вызов → checkpoint → дедуп → сохранение) прямо внутри этого
// HTTP-запроса — это и было первопричиной таймаутов AI-стратега, чинившихся
// в более ранних ТЗ. Теперь POST — чистая вставка строки run со
// status='running'/current_stage='context' и БЕЗ active_worker_id — Worker
// сам подхватывает такие run'ы в своём poll-цикле (см. strategy-loop.ts в
// medizin-worker) и выполняет ЕДИНСТВЕННЫЙ вызов Anthropic для всей системы.
// SSR больше не обращается к Anthropic и не требует ANTHROPIC_API_KEY.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const TOPIC_COUNTS = [10, 20, 30, 50];
const STRATEGIES = ["max_traffic", "fill_gaps", "strengthen_cluster", "seasonal"] as const;

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    // Список без "candidates" (может быть тяжёлым) — для истории запусков (п.13 ТЗ).
    const { data, error } = await admin
      .from("content_strategy_runs")
      .select("id, created_at, updated_at, completed_at, params, status, current_stage, stats, model, usage_input_tokens, usage_output_tokens, estimated_cost_usd, duration_ms, error, last_error")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return json({ ok: false, error: "Не удалось получить историю исследований" }, 200);

    // Исправление завершения старых запусков (новое ТЗ, п.5) — "running"
    // старше 10 минут лениво помечается "interrupted" прямо здесь, при
    // первом же чтении истории (список — самое частое место, откуда
    // администратор вообще видит зависшие run'ы). Та же функция, что
    // использует Worker в своём poll-цикле — общий код из vitaminia-shared.
    const items = await markStaleRunningInList(admin, data ?? []);

    return json({ ok: true, items });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const body = await request.json().catch(() => null);
    const topicCount = TOPIC_COUNTS.includes(body?.topicCount) ? body.topicCount : 20;
    const strategy = STRATEGIES.includes(body?.strategy) ? body.strategy : "max_traffic";
    const clusterCategory = typeof body?.clusterCategory === "string" ? body.clusterCategory : undefined;

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    // Единственное, что делает SSR: создаёт черновую строку запуска. Worker
    // подхватит её в очередном опросе content_strategy_runs (не требует,
    // чтобы Worker был запущен прямо сейчас — запись подождёт в 'running'
    // без active_worker_id, пока Worker не возьмёт её в обработку).
    const { data: run, error: createError } = await admin
      .from("content_strategy_runs")
      .insert({
        params: { topicCount, strategy, clusterCategory },
        status: "running",
        current_stage: "context",
        stats: {},
        model: null,
        created_by: access.userId,
      })
      .select("*")
      .single();
    if (createError || !run) return json({ ok: false, error: "Не удалось создать исследование" }, 200);

    return json({ ok: true, run });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
