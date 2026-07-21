import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../../lib/server/service-role-supabase";
import { normalizeJobDetail } from "vitaminia-shared/normalize-job.mjs";

// ТЗ "Аудит AI-производства и автономная очередь", требование "позволять
// повторить упавшее задание" — POST /api/admin/content/jobs/[id]/retry-stage
//
// Раньше у job'а, исчерпавшего MAX_STAGE_ATTEMPTS на research/draft/
// medical_review/final_review (needs_decision, failure_kind='infra_error' —
// см. run-stage.ts), НЕ БЫЛО вообще никакого пути назад в производство:
// countErrorAttempts считает ВСЕ error-строки content_job_runs за всю
// историю job'а, они никогда не удаляются — то есть лимит, будучи один раз
// исчерпан, оставался исчерпанным навсегда. Единственные действия decision.ts
// (return/reject/archive/publish) либо не подходили содержательно (return
// жёстко ведёт в 'draft', независимо от того, на каком этапе реально
// произошёл сбой), либо просто закрывали job, не решая проблему.
//
// Это ТОЛЬКО сбрасывает точку отсчёта попыток (last_retry_at = now) и
// возвращает job в тот статус, из которого current_stage может снова
// продвигаться — САМ этап не выполняется здесь синхронно (никакого AI-вызова
// в этом запросе нет): следующий цикл автономного воркера (или явный
// повторный клик "Продолжить сейчас") подхватит job обычным образом. Именно
// поэтому это НЕ возврат к старой архитектуре "клик = обработка" — это
// просто "снять пометку недоступности", а КТО и КОГДА реально обработает —
// решает воркер, не этот запрос.
//
// Разрешено ТОЛЬКО для failure_kind='infra_error' (техническая неудача
// вызова/лимит попыток) — для 'content_review' (реальная медицинская/SEO
// проблема, найденная проверкой) слепой повтор не имеет смысла: нужно
// решение человека через decision.ts (return на доработку/reject/archive),
// не может "рассосаться" сам по себе от одной лишь новой попытки.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const STAGE_TO_STATUS: Record<string, string> = {
  research: "researching",
  draft: "drafting",
  medical_review: "medical_review",
  final_review: "final_review",
  seo_review: "seo_review",
};

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

    const { data: job, error: jobError } = await admin.from("content_jobs").select("*").eq("id", id).single();
    if (jobError || !job) return json({ ok: false, error: "Задача не найдена" }, 200);

    if (job.status !== "needs_decision") {
      return json({ ok: false, error: `Повторить можно только задачу в статусе "нужно решение" (сейчас: "${job.status}")` }, 200);
    }
    if (job.failure_kind !== "infra_error") {
      return json({
        ok: false,
        error: "Это не техническая неудача, а содержательная проблема (найдена проверкой) — повтор её не решит. Используйте решение (вернуть на доработку/отклонить/архивировать).",
      }, 200);
    }
    const nextStatus = STAGE_TO_STATUS[job.current_stage];
    if (!nextStatus) {
      return json({ ok: false, error: `Неизвестный этап "${job.current_stage}" — повтор невозможен.` }, 200);
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
        last_retry_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    const { data: updatedJob } = await admin.from("content_jobs").select("*").eq("id", id).single();
    return json({ ok: true, job: normalizeJobDetail(updatedJob) });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
