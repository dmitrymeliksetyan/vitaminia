import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../../../lib/server/service-role-supabase";
import { STRATEGY_TO_REASON, priorityToIdeaPriority } from "vitaminia-shared/strategy-reason-priority.mjs";

// SEO/Контент, Этап 3.1 — POST /api/admin/content/strategy/runs/[id]/commit (п.11 ТЗ)
//
// Превращает ВЫБРАННЫЕ кандидаты в обычные строки content_ideas — та же
// таблица, что и у тем, добавленных вручную (никакой параллельной очереди).
// P0-P3 (приоритет темы в исследовании) — это НЕ то же самое, что
// high/medium/low content_ideas.priority; сопоставление осознанное и явное,
// а не механическое (см. strategy-dedupe.ts — общее место для STRATEGY_TO_REASON/
// priorityToIdeaPriority, используемое ТАКЖЕ автосохранением контент-плана в
// strategy-pipeline.ts, см. исправление завершения старых запусков).
//
// ВАЖНО (исправление завершения старых запусков, новое ТЗ): начиная с этого
// исправления, НОВЫЕ и ВОЗОБНОВЛЁННЫЕ (resume) запуски сами сохраняют ВСЕ
// прошедшие фильтрацию темы в content_ideas и сразу завершаются как
// 'completed' — см. strategy-pipeline.ts. Этот роут (ручной выбор части
// кандидатов) остаётся рабочим ТОЛЬКО для run'ов, всё ещё находящихся в
// статусе 'ready' (созданных до этого исправления) — для них он не удалён и
// не изменён по поведению.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const id = params.id;
    if (!id) return json({ ok: false, error: "Не указан ID" }, 200);

    const body = await request.json().catch(() => null);
    const selectedIndices: number[] = Array.isArray(body?.selectedIndices) ? body.selectedIndices : [];

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data: run, error: runError } = await admin.from("content_strategy_runs").select("*").eq("id", id).single();
    if (runError || !run) return json({ ok: false, error: "Исследование не найдено" }, 200);
    if (run.status !== "ready") return json({ ok: false, error: `Исследование в статусе "${run.status}" — добавлять темы уже нельзя` }, 200);

    const candidates: any[] = Array.isArray(run.candidates) ? run.candidates : [];
    const selected = candidates.filter((_, i) => selectedIndices.includes(i));
    if (selected.length === 0) return json({ ok: false, error: "Не выбрано ни одной темы" }, 200);

    const strategyKey = run.params?.strategy ?? "max_traffic";
    const reason = STRATEGY_TO_REASON[strategyKey] ?? "search_demand";

    const rows = selected.map((c) => ({
      working_title: c.title,
      slug: c.proposedSlug ?? null,
      category: c.category ?? null,
      reason,
      priority: priorityToIdeaPriority(c.priority),
      status: "idea",
      conflict_note: c.duplicateCheckResult?.note ?? null,
      created_by: access.userId,
      source: "ai_strategy",
      strategy_run_id: id,
      // Упрощение AI-стратега (новое ТЗ, п.1) — priority_score и есть новый
      // "strategy_score", посчитанный кодом (strategy-dedupe.ts), а не AI.
      // Старые 6-факторные strategy_score/intent_score/medical_value_score/
      // gap_score/linking_score/seasonality_score колонки НЕ заполняются для
      // новых строк (остаются NULL) — они существуют только ради уже
      // сохранённых старых идей, схему не трогаем (012_content_ideas_priority_v2.sql).
      priority_score: c.priorityScore ?? null,
      // ТЗ "AI Strategy упрощена" — demand_score/conversion_intent_score/
      // medical_breadth_score/search_intent/related_content больше не
      // заполняются: AI их не предоставляет с этого исправления (см.
      // strategy-dedupe.ts). Для run'ов, созданных ДО этого исправления
      // (candidates jsonb ещё содержит старые поля), c.demandScore и т.п.
      // просто будут undefined — колонки остаются NULL, без ошибки.
      content_gap_score: c.contentGapScore ?? null,
      competition_opportunity_score: c.competitionOpportunityScore ?? null,
      rationale: c.rationale ?? null,
      duplicate_check_result: c.duplicateCheckResult ?? null,
    }));

    const { error: insertError } = await admin.from("content_ideas").insert(rows);
    if (insertError) return json({ ok: false, error: "Не удалось добавить темы в контент-план", detail: insertError.message }, 200);

    const newStats = { ...(run.stats ?? {}), addedCount: selected.length };
    await admin.from("content_strategy_runs").update({ status: "completed", stats: newStats, updated_at: new Date().toISOString() }).eq("id", id);

    return json({ ok: true, added: selected.length });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
