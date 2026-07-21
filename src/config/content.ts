import { getCollection, type CollectionEntry } from "astro:content";
import registryIds from "../data/content-registry.ids.json";

export type CategoryEntry = CollectionEntry<"categories">;
export type NutrientEntry = CollectionEntry<"nutrients">;

// Registro de publicación (content-registry) — igual que en la plataforma
// base: content-registry.ids.json es JSON plano, se puede importar aquí
// directo sin ciclo de dependencias con content-registry.ts.
interface RegistryIdEntryLite {
  id: string;
  type: string;
  key: string;
}
const nutrientIdByKey = new Map(
  (registryIds as RegistryIdEntryLite[]).filter((e) => e.type === "nutrient").map((e) => [e.key, e.id])
);

let validated = false;

/**
 * Chequeos de integridad de contenido en build-time.
 * Se ejecuta de forma perezosa en el primer acceso a los datos (ver funciones
 * abajo), así falla en `astro build` y no en una página rota en producción.
 */
async function validateContentIntegrity() {
  if (validated) return;

  const categories = await getCollection("categories");
  const nutrients = await getCollection("nutrients");

  // 1. El slug de la categoría debe coincidir con el slug generado por Astro.
  for (const c of categories) {
    if (c.data.slug !== c.slug) {
      throw new Error(
        `Category slug mismatch: file "${c.id}" has frontmatter.slug="${c.data.slug}"`
      );
    }
  }

  // 2. El slug del nutriente debe coincidir con el último segmento del slug
  //    generado ("minerales/magnesio" → "magnesio") y category debe coincidir
  //    con la carpeta.
  const seenSlugs = new Map<string, string>();
  for (const n of nutrients) {
    const folderTopic = n.id.split("/")[0];
    const categoryRef = typeof n.data.category === "string" ? n.data.category : (n.data.category as { id: string }).id;

    if (n.data.slug !== n.slug) {
      throw new Error(
        `Nutrient slug mismatch: file "${n.id}" has frontmatter.slug="${n.data.slug}"`
      );
    }

    if (categoryRef !== folderTopic) {
      throw new Error(
        `Nutrient category/folder mismatch: "${n.id}" has category="${categoryRef}" but lives under "${folderTopic}/"`
      );
    }

    // 3. Unicidad de slug en todo el árbol.
    if (seenSlugs.has(n.data.slug)) {
      throw new Error(
        `Duplicate nutrient slug "${n.data.slug}": ${seenSlugs.get(n.data.slug)} and ${n.id}`
      );
    }
    seenSlugs.set(n.data.slug, n.id);
  }

  // 4. manualRelated debe ser un array y referenciar slugs existentes.
  const allSlugs = new Set(nutrients.map((n) => n.data.slug));
  for (const n of nutrients) {
    const manualRelated = n.data.manualRelated;
    if (!Array.isArray(manualRelated)) {
      const categoryRef = typeof n.data.category === "string" ? n.data.category : (n.data.category as { id: string }).id;
      const registryId = nutrientIdByKey.get(`${categoryRef}/${n.data.slug}`) ?? "NUT-???";
      throw new Error(`${registryId}\nsrc/content/nutrients/${n.id}\nmanualRelated must be an array`);
    }
    for (const rel of manualRelated) {
      if (!allSlugs.has(rel)) {
        throw new Error(
          `Nutrient "${n.id}" (slug "${n.data.slug}") has manualRelated entry "${rel}" which does not exist`
        );
      }
    }
  }

  validated = true;
}

export async function getAllCategories(): Promise<CategoryEntry[]> {
  await validateContentIntegrity();
  const categories = await getCollection("categories");
  return categories.sort((a, b) => a.data.order - b.data.order);
}

export async function getCategoryBySlug(slug: string): Promise<CategoryEntry> {
  await validateContentIntegrity();
  const categories = await getCollection("categories");
  const entry = categories.find((c) => c.slug === slug);
  if (!entry) throw new Error(`Category not found: "${slug}"`);
  return entry;
}

export async function getAllNutrients(): Promise<NutrientEntry[]> {
  await validateContentIntegrity();
  return getCollection("nutrients");
}

/**
 * `draft: true` en el frontmatter oculta la página del sitio público y del
 * sitemap (mismo mecanismo que "isLiveNutrient" en la plataforma base).
 */
export function isLiveNutrient(entry: NutrientEntry): boolean {
  const d = entry.data as unknown as { draft?: boolean; shortAnswer?: string };
  if (d.draft === true) return false;
  if (typeof d.shortAnswer === "string" && d.shortAnswer.includes("Contenido en preparación")) return false;
  return true;
}

export function categoryIdOf(entry: NutrientEntry): string {
  return typeof entry.data.category === "string"
    ? entry.data.category
    : (entry.data.category as { id: string }).id;
}

/** Solo los nutrientes publicados (no-borrador) — lo que debe ser público. */
export async function getLiveNutrients(): Promise<NutrientEntry[]> {
  const all = await getAllNutrients();
  return all.filter(isLiveNutrient);
}

export async function getNutrientsByCategory(categorySlug: string): Promise<NutrientEntry[]> {
  const all = await getLiveNutrients();
  return all.filter((n) => categoryIdOf(n) === categorySlug);
}

export async function getNutrientBySlug(categorySlug: string, slug: string): Promise<NutrientEntry> {
  await validateContentIntegrity();
  const all = await getCollection("nutrients");
  const entry = all.find((n) => n.slug === slug && categoryIdOf(n) === categorySlug);
  if (!entry) throw new Error(`Nutrient not found: "${categorySlug}/${slug}"`);
  return entry;
}

/**
 * Nutrientes relacionados — mismo orden de prioridad que la plataforma base:
 *   1. relaciones explícitas (manualRelated — override manual del editor);
 *   2. mismo tema (intersección de tags), de mayor a menor coincidencia;
 *   3. misma categoría (fallback, solo si 1–2 no alcanzan el mínimo).
 */
const RELATED_MIN = 3;
const RELATED_MAX = 6;

export async function getRelatedNutrients(entry: NutrientEntry, limit = RELATED_MAX): Promise<NutrientEntry[]> {
  const all = await getLiveNutrients();

  const manualRelatedRaw: string[] = Array.isArray(entry.data.manualRelated) ? entry.data.manualRelated : [];
  const manual = manualRelatedRaw
    .map((slug: string) => all.find((n: NutrientEntry) => n.data.slug === slug))
    .filter((n: NutrientEntry | undefined): n is NutrientEntry => Boolean(n && n.data.slug !== entry.data.slug));

  const pickedSlugs = new Set(manual.map((n: NutrientEntry) => n.data.slug));
  pickedSlugs.add(entry.data.slug);
  const entryTags = new Set(entry.data.tags as string[]);

  const byTagOverlap = all
    .filter((n: NutrientEntry) => !pickedSlugs.has(n.data.slug))
    .map((n: NutrientEntry) => ({ entry: n, overlap: (n.data.tags as string[]).filter((t: string) => entryTags.has(t)).length }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .map((x) => x.entry);

  let result = [...manual, ...byTagOverlap];
  for (const n of byTagOverlap) pickedSlugs.add(n.data.slug);

  if (result.length < RELATED_MIN) {
    const category = categoryIdOf(entry);
    const sameCategory = all.filter((n) => !pickedSlugs.has(n.data.slug) && categoryIdOf(n) === category);
    result = [...result, ...sameCategory];
  }

  return result.slice(0, Math.max(RELATED_MIN, Math.min(limit, RELATED_MAX)));
}
