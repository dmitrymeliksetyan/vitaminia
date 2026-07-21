/**
 * Node-only reader of the Vitaminia Content Registry — общий модуль пакета
 * vitaminia-shared. Форк content-registry-lib.mjs из medizin-shared, сильно
 * упрощён: у Vitaminia ОДИН тип контента (nutrient) вместо symptom/drug —
 * никакой отдельной drug-ветки, никакого category-folder для drug'ов.
 *
 * Читает:
 *   - <rootDir>/src/content/categories (mdx frontmatter)
 *   - <rootDir>/src/content/nutrients, одна подпапка на категорию (mdx frontmatter)
 *   - <rootDir>/src/data/content-registry.ids.json       (постоянные ID)
 *   - <rootDir>/src/data/content-registry.overrides.json (статус/качество/заметки)
 *   - <rootDir>/src/data/content-registry.retired.json   (история объединённого/удалённого контента)
 *
 * rootDir передаётся явным параметром (не вычисляется из __dirname) — тот же
 * приём, что и в medizin-shared: vitaminia-live передаёт корень своего же
 * репозитория, vitaminia-worker — путь к локальному git-чекауту сайта (см.
 * content-checkout.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

function readFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`No frontmatter found in ${filePath}`);
  }
  const data = yaml.load(match[1]) ?? {};
  const body = match[2].trim();
  return { data, body };
}

function listMdxFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMdxFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      out.push(full);
    }
  }
  return out;
}

function loadIds(idsPath) {
  return JSON.parse(fs.readFileSync(idsPath, "utf-8"));
}

function loadOverrides(overridesPath) {
  if (!fs.existsSync(overridesPath)) return {};
  return JSON.parse(fs.readFileSync(overridesPath, "utf-8"));
}

function loadRetired(retiredPath) {
  if (!fs.existsSync(retiredPath)) return [];
  return JSON.parse(fs.readFileSync(retiredPath, "utf-8"));
}

function findId(ids, type, key) {
  const rec = ids.find((r) => r.type === type && r.key === key);
  if (!rec) return null;
  return rec.id;
}

/**
 * Строит полный registry как обычные объекты (та же форма, что и
 * ContentRegistryItem в src/data/content-registry.ts, без TS-типов).
 *
 * @param {string} rootDir — корень чекаута, откуда читать `src/content/**`
 *   и `src/data/content-registry.*.json`.
 */
export function buildRegistry(rootDir) {
  if (!rootDir) throw new Error("buildRegistry(rootDir): rootDir обязателен.");

  const CAT_DIR = path.join(rootDir, "src/content/categories");
  const NUT_DIR = path.join(rootDir, "src/content/nutrients");
  const IDS_PATH = path.join(rootDir, "src/data/content-registry.ids.json");
  const OVERRIDES_PATH = path.join(rootDir, "src/data/content-registry.overrides.json");
  const RETIRED_PATH = path.join(rootDir, "src/data/content-registry.retired.json");

  const ids = loadIds(IDS_PATH);
  const overrides = loadOverrides(OVERRIDES_PATH);
  const items = [];
  const problems = [];

  // --- categories ---
  const categoryFiles = fs
    .readdirSync(CAT_DIR)
    .filter((f) => f.endsWith(".mdx"))
    .sort();
  const categorySlugs = new Set();

  for (const file of categoryFiles) {
    const full = path.join(CAT_DIR, file);
    const { data } = readFrontmatter(full);
    categorySlugs.add(data.slug);
    const id = findId(ids, "category", data.slug);
    if (!id) {
      problems.push(`No permanent ID for category "${data.slug}" (file: categories/${file})`);
      continue;
    }
    const url = `/${data.slug}`;
    const base = {
      id,
      title: data.title,
      slug: data.slug,
      url,
      contentType: "nutrient_category",
      status: "published",
      source: `src/content/categories/${file}`,
      canonical: url,
      inSitemap: true,
    };
    items.push({ ...base, ...(overrides[id] ?? {}) });
  }

  // --- nutrients ---
  const nutrientFiles = listMdxFiles(NUT_DIR).sort();
  const seenSlugs = new Map();

  for (const full of nutrientFiles) {
    const rel = path.relative(rootDir, full);
    const folder = path.basename(path.dirname(full));
    const { data, body } = readFrontmatter(full);

    if (data.slug !== path.basename(full, ".mdx")) {
      problems.push(`Slug mismatch in ${rel}: frontmatter slug="${data.slug}" but filename is different`);
    }
    if (data.category !== folder) {
      problems.push(`Category/folder mismatch in ${rel}: category="${data.category}" but file lives in "${folder}/"`);
    }
    if (!categorySlugs.has(data.category)) {
      problems.push(`Unknown category "${data.category}" referenced in ${rel}`);
    }
    if (seenSlugs.has(data.slug)) {
      problems.push(`DUPLICATE SLUG "${data.slug}": ${seenSlugs.get(data.slug)} and ${rel}`);
    }
    seenSlugs.set(data.slug, rel);

    const key = `${data.category}/${data.slug}`;
    const id = findId(ids, "nutrient", key);
    if (!id) {
      problems.push(`No permanent ID for nutrient "${key}" (file: ${rel})`);
      continue;
    }

    const url = `/${data.category}/${data.slug}`;
    const isStub =
      Boolean(data.draft) || (typeof data.shortAnswer === "string" && data.shortAnswer.includes("Contenido en preparación"));

    const base = {
      id,
      title: data.title,
      slug: data.slug,
      url,
      contentType: "nutrient",
      category: data.category,
      status: isStub ? "draft" : "published",
      source: rel,
      titleTag: data.seoTitle ?? `${data.title} — Vitaminia.mx`,
      metaDescription: data.seoDescription ?? data.shortAnswer,
      h1: data.title,
      canonical: url,
      inSitemap: true,
      updatedAt: data.updated ? String(data.updated) : undefined,
      tags: data.tags ?? [],
      manualRelated: data.manualRelated ?? [],
      sources: data.sources,
      _raw: { data, body, file: rel },
    };
    items.push({ ...base, ...(overrides[id] ?? {}) });
  }

  // --- static/system pages (no MDX source — id record itself carries the metadata) ---
  for (const rec of ids) {
    if (rec.type !== "page") continue;
    const base = {
      id: rec.id,
      title: rec.title ?? rec.key,
      slug: rec.key,
      url: rec.url ?? "/",
      contentType: rec.contentType ?? "other",
      status: "published",
      source: `src/pages (${rec.key})`,
    };
    items.push({ ...base, ...(overrides[rec.id] ?? {}) });
  }

  // --- retired entries (merged into / removed) ---
  const retired = loadRetired(RETIRED_PATH);
  for (const r of retired) {
    if ((r.status === "merge" && r.mergedInto && !ids.some((i) => i.id === r.mergedInto)) ||
        (r.status === "do_not_create" && r.duplicateOf && !ids.some((i) => i.id === r.duplicateOf))) {
      problems.push(`Retired entry ${r.id} points to a target ID that no longer exists in content-registry.ids.json`);
    }
    items.push({
      id: r.id,
      title: r.title,
      slug: r.slug,
      url: r.oldUrl,
      contentType: r.contentType,
      category: r.category,
      status: r.status,
      source: "src/data/content-registry.retired.json",
      duplicateOf: r.mergedInto ?? r.duplicateOf,
      notes: r.notes,
      retired: true,
      redirect: r.redirect,
    });
  }

  return { items, problems };
}

export function loadRawIds(rootDir) {
  if (!rootDir) throw new Error("loadRawIds(rootDir): rootDir обязателен.");
  return loadIds(path.join(rootDir, "src/data/content-registry.ids.json"));
}
