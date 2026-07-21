import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../lib/server/service-role-supabase";
import { getContentRegistry } from "../../../../data/content-registry";
import { searchRegistry } from "vitaminia-shared/content-registry/search.mjs";

// SEO/Контент, Этап 2 — GET/POST /api/admin/content/ideas
//
// «Очередь контента» (п.9-11 ТЗ): новые темы для создания, с рабочим
// названием/slug/категорией/причиной/приоритетом/статусом. Хранится в
// content_ideas (см. миграцию content_ideas_queue) — единственная НЕ
// файловая часть Content Registry, потому что добавление идёт из реально
// работающего Cloudflare Worker (нет node:fs на рантайме, файловый Registry
// для этого не подходит — см. отчёт по этапу).
//
// Перед сохранением ВСЕГДА прогоняется searchRegistry() — тот же алгоритм,
// что у `npm run content:find` и поиска в /admin/content (п.10 ТЗ). Если
// найден точный/похожий/retired-конфликт и клиент не прислал
// confirmDespiteConflict:true — запись НЕ сохраняется, конфликт возвращается
// клиенту для осознанного подтверждения человеком (решение не автоматизируется).

export const prerender = false;

// SEO/Контент, Этап 2.1 (п.11 ТЗ) — упрощённая форма добавления темы
// показывает только новый набор причин ниже. Старые значения
// (important_user_topic/replace_split_existing/technical_necessity) остаются
// в списке валидных ТОЛЬКО для обратной совместимости с уже сохранёнными
// идеями (миграция content_ideas_lifecycle_and_reasons — superset, ничего не
// удаляли) — новые идеи через эту форму их больше не пишут.
const REASONS = [
  "gap_in_cluster", "search_demand", "editorial_idea", "user_request", "extend_existing", "other",
  "important_user_topic", "replace_split_existing", "technical_necessity",
] as const;
const PRIORITIES = ["high", "medium", "low"] as const;
const STATUSES = ["idea", "checked", "ready", "in_progress", "created", "rejected", "archived"] as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) return json({ ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" }, access.status);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Очередь временно недоступна" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data, error } = await admin.from("content_ideas").select("*").order("created_at", { ascending: false });
    if (error) return json({ ok: false, error: "Не удалось получить очередь" }, 200);

    const items = (data ?? []).map((r) => ({
      id: r.id as string,
      workingTitle: r.working_title as string,
      slug: r.slug as string | null,
      category: r.category as string | null,
      reason: r.reason as string,
      priority: r.priority as string,
      status: r.status as string,
      conflictNote: r.conflict_note as string | null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));

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
    const workingTitle = typeof body?.workingTitle === "string" ? body.workingTitle.trim() : "";
    const slug = typeof body?.slug === "string" ? body.slug.trim() || null : null;
    const category = typeof body?.category === "string" ? body.category.trim() || null : null;
    const reason = body?.reason;
    const priority = body?.priority ?? "medium";
    const confirmDespiteConflict = body?.confirmDespiteConflict === true;

    if (!workingTitle) return json({ ok: false, error: "Укажите рабочее название темы" }, 200);
    if (!REASONS.includes(reason)) return json({ ok: false, error: "Некорректная причина создания" }, 200);
    if (!PRIORITIES.includes(priority)) return json({ ok: false, error: "Некорректный приоритет" }, 200);

    // Обязательная проверка дублей/истории — та же логика, что у content:find (п.10 ТЗ).
    const registryItems = await getContentRegistry();
    const searchResult = searchRegistry(registryItems, workingTitle);
    const hasConflict = searchResult.recommendation === "exists" || searchResult.recommendation === "retired" || searchResult.recommendation === "check_similar";

    if (hasConflict && !confirmDespiteConflict) {
      return json({
        ok: true,
        saved: false,
        conflict: {
          recommendation: searchResult.recommendation,
          exactLive: searchResult.exactLive.map((i: any) => ({ id: i.id, title: i.title, url: i.url })),
          exactRetired: searchResult.exactRetired.map((i: any) => ({ id: i.id, title: i.title, oldUrl: i.url })),
          similar: searchResult.similar.slice(0, 5).map((r: any) => ({ id: r.item.id, title: r.item.title, score: r.score })),
        },
      });
    }

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Очередь временно недоступна" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const conflictNote = hasConflict
      ? `Сохранено при известном конфликте (${searchResult.recommendation}), подтверждено вручную.`
      : "Явных дублей и похожих тем не найдено на момент добавления.";

    const { data, error } = await admin
      .from("content_ideas")
      .insert({
        working_title: workingTitle,
        slug,
        category,
        reason,
        priority,
        conflict_note: conflictNote,
        created_by: access.userId,
      })
      .select("*")
      .single();

    if (error) return json({ ok: false, error: "Не удалось сохранить тему" }, 200);

    return json({ ok: true, saved: true, item: { id: data.id, workingTitle: data.working_title } });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
