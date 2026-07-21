import { searchRegistry } from "vitaminia-shared/content-registry/search.mjs";

// Этап "Выделение AI Worker в отдельный независимый сервис".
//
// Извлечено из бывшего pipeline.ts (весь остальной файл — AI-конвейер —
// переехал целиком в medizin-worker, см. src/ai/pipeline.ts там). Эта ОДНА
// функция (п.12 ТЗ — проверка дублей ДО начала производства, тем же
// алгоритмом, что и добавление идеи) остаётся в SSR, потому что она нужна
// ТОЛЬКО в момент создания job'а (POST /api/admin/content/jobs.ts) — Worker
// никогда не создаёт job'ы, поэтому ему эта функция не нужна вообще. Не
// является дублированием: searchRegistry — общий алгоритм из vitaminia-shared,
// здесь только тонкая обёртка, формирующая понятный человеку ответ.

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  duplicateCandidates: Array<{ id: string; title: string; url: string; score?: number }>;
}

/** п.12 ТЗ — проверка дублей ДО начала производства, тем же алгоритмом, что и добавление идеи. */
export function preflightDuplicateCheck(registryItems: any[], title: string): PreflightResult {
  const result = searchRegistry(registryItems, title) as any;
  const duplicateCandidates = [
    ...result.exactLive.map((i: any) => ({ id: i.id, title: i.title, url: i.url })),
    ...result.exactRetired.map((i: any) => ({ id: i.id, title: i.title, url: i.url })),
    ...result.similar.slice(0, 3).map((r: any) => ({ id: r.item.id, title: r.item.title, url: r.item.url, score: r.score })),
  ];
  if (result.recommendation === "exists") {
    return { ok: false, reason: `Похоже, материал уже существует: «${result.exactLive[0]?.title}».`, duplicateCandidates };
  }
  if (result.recommendation === "retired") {
    return { ok: false, reason: `Эта тема уже разбиралась ранее и была объединена/удалена: «${result.exactRetired[0]?.title}».`, duplicateCandidates };
  }
  if (result.recommendation === "check_similar") {
    return { ok: false, reason: `Найдена очень похожая тема: «${result.similar[0]?.item.title}» (${Math.round((result.similar[0]?.score ?? 0) * 100)}% схожести). Возможно, новая статья не нужна.`, duplicateCandidates };
  }
  return { ok: true, duplicateCandidates: [] };
}
