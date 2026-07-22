import type { APIRoute } from "astro";
import { checkAdminAccess } from "../../../../lib/admin/auth";
import { getContentRegistry } from "../../../../data/content-registry";

// GET /api/admin/content/registry — единственный серверный роут для раздела
// «Контент» в админке. Гейтинг такой же, как у /api/admin/analytics
// (checkAdminAccess — Bearer-токен + whitelist ADMIN_USER_IDS).
//
// Отдаёт ВЕСЬ Content Registry одним JSON — источник данных ровно тот же,
// что у content-registry.ts (astro:content + content-registry.ids.json).
// Поиск, фильтры, статистика, проверка и группировка по очереди — всё
// считается на клиенте той же общей логикой (vitaminia-shared), чтобы не
// заводить вторую реализацию.

export const prerender = false;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const access = await checkAdminAccess(request, locals);
    if (!access.ok) {
      return json(
        { ok: false, error: access.status === 401 ? "Не авторизован" : "Доступ запрещён" },
        access.status
      );
    }

    const items = await getContentRegistry();
    return json({ ok: true, items, generatedAt: new Date().toISOString() });
  } catch (err) {
    return json({ ok: false, error: "Внутренняя ошибка", detail: String(err) }, 200);
  }
};
