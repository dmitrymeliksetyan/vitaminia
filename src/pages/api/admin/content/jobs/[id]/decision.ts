import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../../lib/server/service-role-supabase";
import { normalizeJobDetail } from "vitaminia-shared/normalize-job.mjs";

// Этап "Выделение AI Worker в отдельный независимый сервис".
//
// ПЕРЕДЕЛАНО: раньше действие "publish" синхронно строило .mdx, проверяло
// frontmatter, обращалось к GitHub (Git Data API) и коммитило файлы — прямо
// внутри этого SSR-запроса. Вся эта логика (buildFinalMdx, registry-publish,
// production-validate, github-client) перенесена в medizin-worker
// (см. src/worker/publish-stage.ts в medizin-worker) — SSR теперь НИЧЕГО не
// знает про AI/GitHub и никогда не делает исходящих запросов к внешним API
// для публикации.
//
// "publish" теперь — чистый триггер: проверяет, что материал в принципе
// готов к публикации (current_stage==='done' и статус — один из
// "публикуемых"), и переводит job в status='validating'. Worker сам
// подхватывает job в этом статусе (опрос content_jobs, см. queue-loop.ts →
// publish-stage.ts в medizin-worker) и проходит весь пайплайн валидации +
// коммита асинхронно. Если Worker сейчас выключен — job просто останется в
// 'validating' и будет обработан, как только Worker снова запустится; сайт
// при этом продолжает работать как обычно.
//
// "return"/"reject"/"archive" уже были чистыми сеттерами статуса — не
// изменились.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const ACTIONS = ["publish", "return", "reject", "archive"] as const;

// Те же статусы, из которых раньше разрешался вызов "publish" — включая
// переходные "validating"/"committing"/"validation_failed"/"commit_failed",
// чтобы повторное нажатие "Опубликовать" могло повторно запустить Worker,
// если предыдущая попытка сорвалась на середине.
const RESUMABLE_PUBLISH_STATUSES = new Set([
  "needs_decision", "approved", "deploy_failed", "validating", "committing", "validation_failed", "commit_failed",
]);

export const POST: APIRoute = async ({ request, locals, params }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const id = params.id;
    if (!id) return json({ ok: false, error: "Не указан ID" }, 200);

    const body = await request.json().catch(() => null);
    const action = body?.action;
    const note = typeof body?.note === "string" ? body.note.trim() || null : null;
    if (!ACTIONS.includes(action)) return json({ ok: false, error: "Некорректное действие" }, 200);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data: job, error: jobError } = await admin.from("content_jobs").select("*").eq("id", id).single();
    if (jobError || !job) return json({ ok: false, error: "Задача не найдена" }, 200);

    if (action === "publish") {
      const canPublish = job.current_stage === "done" && RESUMABLE_PUBLISH_STATUSES.has(job.status);
      if (!canPublish) {
        return json({ ok: false, error: "Материал ещё не прошёл все проверки — публиковать пока нельзя" }, 200);
      }
      // Единственное, что делает SSR: помечает job как "жду публикации" и
      // сбрасывает след предыдущей неудачной попытки. Всё остальное —
      // работа Worker'а (см. publish-stage.ts в medizin-worker).
      await admin
        .from("content_jobs")
        .update({
          status: "validating",
          publish_stage_failed: null,
          decision_reason: note,
          published_by: access.userId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    } else if (action === "return") {
      await admin
        .from("content_jobs")
        // fix_count сбрасывается: новый заход в черновик — это новый цикл медпроверки (Этап 3.2, п.11 ТЗ).
        // return_count растёт — это реальный человеческий "цикл доработки" для Истории (Часть 9, Этап 6 ТЗ).
        .update({ status: "drafting", current_stage: "draft", fix_count: 0, return_count: (job.return_count ?? 0) + 1, decision_reason: note, updated_at: new Date().toISOString() })
        .eq("id", id);
    } else if (action === "reject") {
      await admin.from("content_jobs").update({ status: "rejected", decision_reason: note ?? "Отклонено администратором", updated_at: new Date().toISOString() }).eq("id", id);
      await admin.from("content_ideas").update({ status: "rejected", updated_at: new Date().toISOString() }).eq("id", job.content_idea_id);
    } else if (action === "archive") {
      await admin.from("content_jobs").update({ status: "archived", decision_reason: note, updated_at: new Date().toISOString() }).eq("id", id);
    }

    const { data: updatedJob } = await admin.from("content_jobs").select("*").eq("id", id).single();
    return json({ ok: true, job: normalizeJobDetail(updatedJob) });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
