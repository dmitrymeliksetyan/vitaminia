/**
 * Vitaminia Content Registry — единый машинно-читаемый реестр всего контента сайта.
 *
 * ВАЖНО: этот файл НЕ хранит вторую копию контента. Название, slug, категория,
 * SEO-поля, даты и т.п. всегда читаются напрямую из реального источника истины —
 * коллекций Astro Content Collections (`src/content.config.ts` + файлы в
 * `src/content/**`). Здесь хранится только:
 *   1) постоянный ID каждой единицы контента (см. content-registry.ids.json),
 *   2) тонкий слой редакторских метаданных, которых нет во frontmatter —
 *      status, quality, duplicateOf, relatedContentIds, notes и т.п.
 *      (см. content-registry.overrides.json).
 *
 * Если завтра поменяется текст симптома или его SEO-описание — этот файл
 * ничего не узнает и узнавать не должен: он просто заново прочитает актуальные
 * данные из коллекции при следующем вызове getContentRegistry().
 *
 * Для CLI-инструментов (`npm run content:check`, `npm run content:find`),
 * которые не могут импортировать виртуальный модуль `astro:content` вне
 * Astro-рантайма, есть параллельный Node-скрипт `scripts/content-registry-lib.mjs`.
 * Он читает те же самые MDX-файлы и те же самые ids/overrides JSON —
 * то есть данные не расходятся, расходится только механизм чтения файлов.
 */
import {
  getAllCategories,
  getAllNutrients,
  categoryIdOf,
  type CategoryEntry,
  type NutrientEntry,
} from "../config/content";
import idsData from "./content-registry.ids.json";
import overridesData from "./content-registry.overrides.json";
import retiredData from "./content-registry.retired.json";

export type ContentType =
  | "nutrient"
  | "nutrient_category"
  | "about"
  | "faq"
  | "legal"
  | "service"
  | "system"
  | "other";

// Зарезервировано на будущее (Задача 2 ТЗ) — пока не используется:
// | "disease" | "test" | "lab_marker" | "procedure" | "first_aid" | "drug" | "doctor_specialty"

export type ContentStatus =
  | "published"
  | "draft"
  | "planned"
  | "duplicate"
  | "merge"
  | "update"
  | "do_not_create";

export interface ContentRegistryItem {
  id: string;
  title: string;
  slug: string;
  url: string;
  contentType: ContentType;
  category?: string;
  status: ContentStatus;
  source: string;
  quality?: "A" | "B" | "C";
  duplicateOf?: string;
  parentContentId?: string;
  relatedContentIds?: string[];
  titleTag?: string;
  metaDescription?: string;
  h1?: string;
  canonical?: string;
  inSitemap?: boolean;
  publishedAt?: string;
  updatedAt?: string;
  auditedAt?: string;
  notes?: string;
  /** true для записей из content-registry.retired.json — контент объединён/удалён, URL больше не существует */
  retired?: boolean;
  redirect?: string;
  /** только для symptom — используется общей поисковой логикой (src/lib/content-registry/search.mjs) для tag-overlap */
  tags?: string[];
  manualRelated?: string[];
  severity?: "low" | "medium" | "high";
  /** ТЗ "не блокировать публикацию из-за отсутствия источников" — только для symptom, используется computeContentHealth() для предупреждения "Не указаны источники" (публикация без источников больше не блокер, но остаётся видимой как замечание качества). */
  sources?: Array<{ title?: string; url?: string }>;
}

type RetiredRecord = {
  id: string;
  title: string;
  slug: string;
  oldUrl: string;
  contentType: string;
  category?: string;
  status: "merge" | "do_not_create";
  mergedInto?: string;
  duplicateOf?: string;
  redirect?: string;
  retiredAt: string;
  notes?: string;
};

type IdRecord = {
  id: string;
  type: "category" | "nutrient" | "page";
  key: string;
  url?: string;
  title?: string;
  contentType?: string;
};

type OverrideRecord = Partial<
  Pick<
    ContentRegistryItem,
    | "status"
    | "quality"
    | "duplicateOf"
    | "parentContentId"
    | "relatedContentIds"
    | "notes"
    | "auditedAt"
    | "inSitemap"
  >
>;

const ids = idsData as IdRecord[];
// overrides.json — некоторые записи (например, SYM-030, статус do_not_create)
// хранят "quality": null, т.к. оценка неприменима. Это валидный JSON, но не
// совпадает буквально с типом ContentRegistryItem["quality"] (A|B|C|undefined).
// Двойное приведение типа здесь безопасно: applyOverride делает {...base, ...o},
// и null, и undefined одинаково дают "Без оценки" в UI (см. QualityBadge).
const overrides = overridesData as unknown as Record<string, OverrideRecord>;
const retired = retiredData as RetiredRecord[];

function findId(type: IdRecord["type"], key: string): string {
  const rec = ids.find((r) => r.type === type && r.key === key);
  if (!rec) {
    throw new Error(
      `content-registry: no permanent ID assigned for ${type} "${key}". ` +
        `Add an entry to content-registry.ids.json (append-only — never renumber existing entries).`
    );
  }
  return rec.id;
}

function applyOverride(base: ContentRegistryItem): ContentRegistryItem {
  const o = overrides[base.id];
  if (!o) return base;
  return { ...base, ...o };
}

function categoryToRegistryItem(c: CategoryEntry): ContentRegistryItem {
  const id = findId("category", c.data.slug);
  const url = `/${c.data.slug}`;
  return applyOverride({
    id,
    title: c.data.title,
    slug: c.data.slug,
    url,
    contentType: "nutrient_category",
    status: "published",
    source: `src/content/categories/${c.id}`,
    titleTag: c.data.seoTitle ?? `${c.data.title} — Vitaminia.mx`,
    metaDescription: c.data.seoDescription ?? c.data.description,
    h1: c.data.title,
    canonical: url,
    inSitemap: true,
  });
}

function symptomToRegistryItem(s: NutrientEntry): ContentRegistryItem {
  const category = categoryIdOf(s);
  const id = findId("nutrient", `${category}/${s.data.slug}`);
  const url = `/${category}/${s.data.slug}`;
  return applyOverride({
    id,
    title: s.data.title,
    slug: s.data.slug,
    url,
    contentType: "nutrient",
    category,
    status: "published",
    source: `src/content/nutrients/${s.id}`,
    titleTag: s.data.seoTitle ?? `${s.data.title} — Vitaminia.mx`,
    metaDescription: s.data.seoDescription ?? s.data.shortAnswer,
    h1: s.data.title,
    canonical: url,
    inSitemap: true,
    updatedAt:
      s.data.updated instanceof Date
        ? s.data.updated.toISOString().slice(0, 10)
        : String(s.data.updated),
    tags: s.data.tags,
    manualRelated: s.data.manualRelated,
    sources: s.data.sources,
  });
}

function retiredToRegistryItem(r: RetiredRecord): ContentRegistryItem {
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    url: r.oldUrl,
    contentType: (r.contentType as ContentType) ?? "nutrient",
    category: r.category,
    status: r.status,
    source: "src/data/content-registry.retired.json",
    duplicateOf: r.mergedInto ?? r.duplicateOf,
    notes: r.notes,
    auditedAt: r.retiredAt,
    retired: true,
    redirect: r.redirect,
  };
}

function pageToRegistryItem(rec: IdRecord): ContentRegistryItem {
  return applyOverride({
    id: rec.id,
    title: rec.title ?? rec.key,
    slug: rec.key,
    url: rec.url ?? "/",
    contentType: (rec.contentType as ContentType) ?? "other",
    status: "published",
    source: `src/pages (${rec.key})`,
  });
}

/**
 * Собирает полный Content Registry на лету из реальных источников контента.
 * Ничего не кэширует между вызовами дольше, чем один module-level import, —
 * поэтому реестр никогда не может "устареть" относительно реального сайта.
 */
export async function getContentRegistry(): Promise<ContentRegistryItem[]> {
  const [categories, symptoms] = await Promise.all([getAllCategories(), getAllNutrients()]);

  const items: ContentRegistryItem[] = [
    ...categories.map(categoryToRegistryItem),
    ...symptoms.map(symptomToRegistryItem),
    ...ids.filter((r) => r.type === "page").map(pageToRegistryItem),
    ...retired.map(retiredToRegistryItem),
  ];

  return items;
}

export async function getRegistrySummary() {
  const items = await getContentRegistry();
  const byStatus: Record<string, number> = {};
  const byQuality: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const item of items) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    if (item.quality) byQuality[item.quality] = (byQuality[item.quality] ?? 0) + 1;
    byType[item.contentType] = (byType[item.contentType] ?? 0) + 1;
  }
  return { total: items.length, byStatus, byQuality, byType };
}
