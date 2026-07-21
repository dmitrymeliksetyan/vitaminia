import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../../../lib/admin/auth";
import { getRuntimeEnv } from "../../../../../../lib/assistant/runtime-env";
import { getServiceRoleSupabase } from "../../../../../../lib/server/service-role-supabase";
import { normalizeJobDetail } from "vitaminia-shared/normalize-job.mjs";
import { siteConfig } from "../../../../../../config/site";

// SEO/Контент, Этап 7 (Часть 13 ТЗ, «честная публикация») — POST
// /api/admin/content/jobs/[id]/check-deploy
//
// После коммита в GitHub (decision.ts, action="publish") статус job —
// 'deploying', НЕ 'published'. У нас нет Cloudflare API credentials, чтобы
// напрямую спросить статус деплоя ("Cloudflare начал build/build завершился
// успешно" из п.13 — шаги 5-6 ТЗ технически недоступны без них, это прямо
// зафиксировано как ограничение в отчёте Этапа 6). Вместо этого — честная
// замена, доступная без дополнительных credentials: реальный HTTP-запрос к
// публичному URL материала. Если страница действительно отдаёт 200 и в ней
// есть заголовок статьи — материал реально на сайте, статус меняется на
// 'published'. Если нет — статус остаётся 'deploying' ("Ожидается сборка
// сайта"), можно повторить позже. Это НЕ отличает "ещё собирается" от
// "сборка упала намертво" (для этого нужен именно Cloudflare API) — поэтому
// есть отдельное ручное действие "Пометить как ошибку сборки" для случаев,
// когда администратор сам увидел красный крест в дашборде Cloudflare.

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
    const action = body?.action === "mark_failed" ? "mark_failed" : "check";

    const env = getRuntimeEnv(locals);
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return json({ ok: false, error: "Недоступно" }, 200);
    const admin = getServiceRoleSupabase(serviceRoleKey);

    const { data: job, error: jobError } = await admin.from("content_jobs").select("*").eq("id", id).single();
    if (jobError || !job) return json({ ok: false, error: "Задача не найдена" }, 200);

    // Новое ТЗ (п.6): проверка/пометка ошибки деплоя применима только ПОСЛЕ
    // успешного коммита (job.publish_commit_sha уже есть) — до этого статусы
    // validating/committing/validation_failed/commit_failed обрабатываются
    // самим "publish" в decision.ts, не здесь.
    if (job.status !== "deploying" && job.status !== "deploy_failed") {
      return json({ ok: false, error: `Проверка деплоя не применима к статусу "${job.status}"` }, 200);
    }

    if (action === "mark_failed") {
      const note = typeof body?.note === "string" ? body.note.trim() || null : null;
      await admin
        .from("content_jobs")
        .update({
          status: "deploy_failed",
          deploy_checked_at: new Date().toISOString(),
          deploy_check_note: note ?? "Отмечено вручную администратором как ошибка сборки/деплоя.",
          deploy_url_live: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      const { data: updated } = await admin.from("content_jobs").select("*").eq("id", id).single();
      return json({ ok: true, job: normalizeJobDetail(updated) });
    }

    const fm = (job.draft as any)?.frontmatter ?? {};
    const slug = fm.slug ?? job.slug;
    const category = job.category;
    const siteUrl = (env.PUBLIC_SITE_URL as string | undefined)?.trim() || siteConfig.url;
    const publicUrl = `${siteUrl.replace(/\/$/, "")}/${category}/${slug}/`;

    let note: string;
    let live = false;
    try {
      const res = await fetch(publicUrl, { redirect: "follow" });
      if (!res.ok) {
        note = `Страница ${publicUrl} пока недоступна (HTTP ${res.status}) — сборка сайта либо ещё идёт, либо ещё не запущена.`;
      } else {
        const html = await res.text();
        const title = typeof fm.title === "string" ? fm.title : "";
        if (title && html.includes(title)) {
          live = true;
          note = `Страница ${publicUrl} отдаёт 200 и содержит заголовок материала — публикация подтверждена.`;
        } else {
          note = `Страница ${publicUrl} отвечает 200, но заголовок материала не найден в ответе — возможно, отдаётся старая закэшированная версия. Попробуйте проверить ещё раз через минуту.`;
        }
      }
    } catch (err) {
      note = `Не удалось обратиться к ${publicUrl}: ${String(err)}`;
    }

    if (live) {
      await admin
        .from("content_jobs")
        .update({
          status: "published",
          published_at: new Date().toISOString(),
          deploy_checked_at: new Date().toISOString(),
          deploy_check_note: note,
          deploy_url_live: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    } else {
      await admin
        .from("content_jobs")
        .update({ deploy_checked_at: new Date().toISOString(), deploy_check_note: note, deploy_url_live: false, updated_at: new Date().toISOString() })
        .eq("id", id);
    }

    const { data: updated } = await admin.from("content_jobs").select("*").eq("id", id).single();
    return json({ ok: true, live, note, job: normalizeJobDetail(updated) });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
