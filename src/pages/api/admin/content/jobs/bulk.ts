import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../lib/server/service-role-supabase";

// ТЗ "AI Platform 1.0 — Этап 1: Editorial Engine 2.0", п.8 "Массовые
// операции" — POST /api/admin/content/jobs/bulk { action, ids }.
//
// Сознательно НЕ реализованы массовые "Запустить Research"/"Запустить
// Validation"/"Перегенерировать SEO" из примера в ТЗ буквально — это была бы
// синхронная обработка стадии ИЗ БРАУЗЕРА, ровно то, что убрали на этапе
// "Выделение AI Worker в отдельный независимый сервис" (см. Паспорт
// редакции). В нынешней архитектуре автономный воркер сам подхватывает
// job'ы, готовые к очередному этапу, по статусу/локам — вручную "запустить"
// конкретный этап для конкретного job'а нечем и незачем: он либо уже готов
// (и воркер его возьмёт на следующем цикле опроса, макс. через
// WORKER_POLL_INTERVAL_MS), либо ещё не готов (предыдущий этап не завершён).
//
// Поэтому массовые операции здесь — это массовое применение ТЕХ ЖЕ самых
// действий, что уже существуют для одного job'а (retry-stage.ts, decision.ts
// action=publish/archive), просто по списку id одним запросом:
//   - retry   — повторить (только failure_kind='infra_error', как и в
//               одиночном retry-stage.ts — та же защита от бессмысленного
//               повтора содержательных проблем);
//   - publish — поставить в очередь на публикацию (current_stage='done');
//   - archive — снять с производства без публикации.
export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const ACTIONS = ["retry", "publish", "archive"] as const;
type BulkAction = (typeof ACTIONS)[number];

const RESUMABLE_PUBLISH_STATUSES = new Set([
  "needs_decision", "approved", "deploy_failed", "validating", "committing", "validation_failed", "commit_failed",
]);
const STAGE_TO_STATUS: Record<string, string> = {
  research: "researching",
  draft: "drafting",
  medical_review: "medical_review",
  final_review: "final_review",
  seo_review: "seo_review",
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const body = await request.json().catch(() => null);
    const action = body?.action as BulkAction;
    const ids: string[] = Array.isArray(body?.ids) ? body.ids.filter((v: unknown) => typeof v === "string") : [];
    if (!ACTIONS.includes(action)) return json({ ok: false, error: "Некорректное действие" }, 200);
    if (ids.length === 0) return json({ ok: false, error: "Не выбрано ни одной задачи" }, 200);
    if (ids.length > 100) return json({ ok: false, error: "Слишком много задач за один раз (максимум 100)" }, 200);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data: jobs, error: jobsError } = await admin.from("content_jobs").select("*").in("id", ids);
    if (jobsError) return json({ ok: false, error: "Не удалось получить задачи" }, 200);

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    const nowIso = new Date().toISOString();

    for (const id of ids) {
      const job = (jobs ?? []).find((j: any) => j.id === id);
      if (!job) {
        results.push({ id, ok: false, error: "Задача не найдена" });
        continue;
      }
      try {
        if (action === "retry") {
          if (job.status !== "needs_decision") {
            results.push({ id, ok: false, error: `Не в статусе "нужно решение" (сейчас: ${job.status})` });
            continue;
          }
          if (job.failure_kind !== "infra_error") {
            results.push({ id, ok: false, error: "Содержательная проблема — нужно решение человека, не повтор" });
            continue;
          }
          const nextStatus = STAGE_TO_STATUS[job.current_stage];
          if (!nextStatus) {
            results.push({ id, ok: false, error: `Неизвестный этап "${job.current_stage}"` });
            continue;
          }
          await admin
            .from("content_jobs")
            .update({
              status: nextStatus,
              failure_kind: null,
              decision_reason: null,
              active_stage: null,
              active_run_started_at: null,
              active_worker_id: null,
              active_worker_heartbeat_at: null,
              next_attempt_at: null,
              last_retry_at: nowIso,
              updated_at: nowIso,
            })
            .eq("id", id);
          results.push({ id, ok: true });
        } else if (action === "publish") {
          const canPublish = job.current_stage === "done" && RESUMABLE_PUBLISH_STATUSES.has(job.status);
          if (!canPublish) {
            results.push({ id, ok: false, error: "Материал ещё не готов к публикации" });
            continue;
          }
          await admin
            .from("content_jobs")
            .update({ status: "validating", publish_stage_failed: null, published_by: access.userId, updated_at: nowIso })
            .eq("id", id);
          results.push({ id, ok: true });
        } else if (action === "archive") {
          await admin.from("content_jobs").update({ status: "archived", decision_reason: "Массовое архивирование", updated_at: nowIso }).eq("id", id);
          results.push({ id, ok: true });
        }
      } catch (err) {
        results.push({ id, ok: false, error: String(err) });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    return json({ ok: true, succeeded, failed: results.length - succeeded, results });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
