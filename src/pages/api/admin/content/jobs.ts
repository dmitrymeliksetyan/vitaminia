import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../lib/server/service-role-supabase";
import { getContentRegistry } from "../../../../data/content-registry";
import { preflightDuplicateCheck } from "../../../../lib/content-editor/preflight-check";
import { estimateCostUsd } from "vitaminia-shared/cost-estimate.mjs";
import { normalizeJobDetail } from "vitaminia-shared/normalize-job.mjs";

// SEO/Контент, Этап 3 — GET/POST /api/admin/content/jobs
//
// «Контент-план» → «Создать материал» (п.4 ТЗ): создаёт content_job поверх
// уже существующей content_idea. Job — НЕ замена идеи, а производственная
// надстройка над ней (см. миграцию 007_content_jobs.sql). Перед созданием
// ВСЕГДА прогоняется тот же поиск дублей, что и при добавлении идеи (п.12
// ТЗ) — если похоже, что материал уже есть, производство не стартует без
// явного подтверждения человека (confirmDespiteDuplicate).
//
// Этап 3.2.1 (AI-редакция как отдельный блок, п.23 ТЗ): GET дополнительно
// агрегирует content_job_runs по job_id (стоимость/время/число вызовов) —
// это единственные данные, которых не хватало для главного виджета
// AI-редакции на /admin/content. Никакой новой таблицы для этого не
// создаётся: агрегация — это просто GROUP BY поверх уже существующих строк.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data, error } = await admin.from("content_jobs").select("*").order("created_at", { ascending: false });
    if (error) return json({ ok: false, error: "Не удалось получить список задач" }, 200);

    const jobs = data ?? [];
    // Токены добавлены в агрегацию (Этап 5 ТЗ, "показатели производства":
    // требуется "количество токенов" отдельно от стоимости/времени/числа
    // вызовов) — раньше run_stats их не считал вообще.
    const EMPTY_RUN_STATS = { totalCostUsd: 0, totalDurationMs: 0, totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
    const runStatsByJob = new Map<string, typeof EMPTY_RUN_STATS>();
    // ТЗ "Editorial Engine 2.0", п.7 "Карточка материала — Использованная AI
    // модель" — content_job_runs.model уже хранился с самого начала (см.
    // миграцию 007), просто никогда не читался и не показывался в UI.
    // Берём модель ПОСЛЕДНЕГО (по started_at) прогона каждого job'а — это и
    // есть "какая модель сейчас реально используется для этого материала".
    const lastModelByJob = new Map<string, string>();
    if (jobs.length > 0) {
      const { data: runs } = await admin
        .from("content_job_runs")
        .select("job_id, cost_usd, usage_input_tokens, usage_output_tokens, duration_ms, model, started_at")
        .in("job_id", jobs.map((j: any) => j.id))
        .order("started_at", { ascending: true });
      for (const r of runs ?? []) {
        const entry = runStatsByJob.get(r.job_id) ?? { ...EMPTY_RUN_STATS };
        entry.totalCostUsd += r.cost_usd != null ? Number(r.cost_usd) : estimateCostUsd(r.usage_input_tokens ?? 0, r.usage_output_tokens ?? 0);
        entry.totalDurationMs += r.duration_ms ?? 0;
        entry.totalCalls += 1;
        entry.totalInputTokens += r.usage_input_tokens ?? 0;
        entry.totalOutputTokens += r.usage_output_tokens ?? 0;
        runStatsByJob.set(r.job_id, entry);
        // ascending order => последняя перезапись в цикле = самый свежий run.
        if (r.model) lastModelByJob.set(r.job_id, r.model);
      }
    }
    // Этап 6, Часть 9 ТЗ ("История... кто опубликовал") — published_by
    // хранит только UUID (см. миграцию 010); резолвим в email здесь же,
    // одним точечным вызовом на каждого РЕАЛЬНО встретившегося публикатора
    // (обычно 1-2 человека), а не на каждый job по отдельности.
    const publisherIds = Array.from(new Set(jobs.map((j: any) => j.published_by).filter((v: any): v is string => typeof v === "string")));
    const publisherEmailById = new Map<string, string>();
    if (publisherIds.length > 0) {
      await Promise.all(
        publisherIds.map(async (uid) => {
          try {
            const { data } = await admin.auth.admin.getUserById(uid);
            if (data?.user?.email) publisherEmailById.set(uid, data.user.email);
          } catch {
            // Не критично — просто покажем UUID вместо email.
          }
        })
      );
    }

    const itemsWithStats = jobs.map((j: any) => ({
      ...normalizeJobDetail(j),
      run_stats: runStatsByJob.get(j.id) ?? { ...EMPTY_RUN_STATS },
      last_model: lastModelByJob.get(j.id) ?? null,
      published_by_email: j.published_by ? (publisherEmailById.get(j.published_by) ?? null) : null,
    }));

    return json({ ok: true, items: itemsWithStats });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const body = await request.json().catch(() => null);
    const ideaId = typeof body?.ideaId === "string" ? body.ideaId : "";
    const confirmDespiteDuplicate = body?.confirmDespiteDuplicate === true;
    if (!ideaId) return json({ ok: false, error: "Не указана тема (ideaId)" }, 200);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data: idea, error: ideaError } = await admin.from("content_ideas").select("*").eq("id", ideaId).single();
    if (ideaError || !idea) return json({ ok: false, error: "Тема не найдена" }, 200);

    // Один активный job на идею одновременно (см. уникальный индекс в
    // миграции) — проверяем заранее, чтобы дать понятную ошибку, а не
    // упасть на констрейнте БД.
    const { data: existingJobs } = await admin
      .from("content_jobs")
      .select("id, status")
      .eq("content_idea_id", ideaId)
      .not("status", "in", "(published,rejected,archived)");
    if (existingJobs && existingJobs.length > 0) {
      return json({ ok: true, created: false, error: "Для этой темы уже есть незавершённая задача производства", existingJobId: existingJobs[0].id });
    }

    if (!confirmDespiteDuplicate) {
      const registryItems = await getContentRegistry();
      const preflight = preflightDuplicateCheck(registryItems, idea.working_title);
      if (!preflight.ok) {
        return json({ ok: true, created: false, preflight: { reason: preflight.reason, duplicateCandidates: preflight.duplicateCandidates } });
      }
    }

    const { data: job, error: jobError } = await admin
      .from("content_jobs")
      .insert({
        content_idea_id: ideaId,
        title: idea.working_title,
        slug: idea.slug,
        category: idea.category,
        status: "planned",
        current_stage: "research",
        created_by: access.userId,
      })
      .select("*")
      .single();
    if (jobError) return json({ ok: false, error: "Не удалось создать задачу производства" }, 200);

    // Идея переходит "в работу" — визуально совпадает с её собственным
    // жизненным циклом (Этап 2.1: idea/checked/ready/in_progress/created).
    await admin.from("content_ideas").update({ status: "in_progress", updated_at: new Date().toISOString() }).eq("id", ideaId);

    return json({ ok: true, created: true, job });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
