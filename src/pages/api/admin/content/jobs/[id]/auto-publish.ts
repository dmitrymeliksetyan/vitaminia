import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../../lib/server/service-role-supabase";

// ТЗ "Editorial Engine 2.0 — автономный конвейер" (16.07.2026, аудит по
// запросу Дмитрия) — POST /api/admin/content/jobs/[id]/auto-publish
// { autoPublish: boolean }.
//
// По умолчанию (миграция 019, content_jobs.auto_publish=true) конвейер
// доходит от идеи до публикации без остановки на needs_decision, если нет
// реальной проблемы (см. run-stage.ts, ветка seo_review). Этот эндпоинт —
// единственный способ явно включить для КОНКРЕТНОГО материала старый режим
// "остановиться и подождать клика человека перед публикацией" (например,
// чувствительная тема, которую редактор хочет вычитать лично перед тем,
// как она уйдёт в GitHub) — именно то "явное решение о ручном подтверждении",
// о котором просил Дмитрий.
//
// Переключатель ничего не делает с уже идущим конвейером — если материал
// СЕЙЧАС находится в processing (research/draft/...), флаг применится только
// когда он дойдёт до seo_review. Если материал уже стоит в needs_decision
// (current_stage='done', ждёт публикации) — переключение обратно на
// auto_publish=true здесь НЕ публикует его само по себе (это было бы
// неожиданным побочным эффектом от простой смены настройки); публикация
// всё ещё через отдельное действие "Опубликовать".

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
    if (typeof body?.autoPublish !== "boolean") return json({ ok: false, error: "Не указано значение autoPublish" }, 200);

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { error } = await admin
      .from("content_jobs")
      .update({ auto_publish: body.autoPublish, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return json({ ok: false, error: "Не удалось изменить режим публикации" }, 200);

    return json({ ok: true, autoPublish: body.autoPublish });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
