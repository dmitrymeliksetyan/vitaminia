/**
 * Node-only reader of the MEDIZIN Content Registry — общий модуль пакета
 * medizin-shared. Раньше жил как scripts/content-registry-lib.mjs внутри
 * репозитория medizin и вычислял свой ROOT сам, через
 * `path.resolve(__dirname, "..")` (т.е. "на один уровень выше своего же
 * файла") — это работало, ПОКА единственным местом, где лежит проверяемый
 * контент (`src/content/**`, `src/data/content-registry.*.json`), был тот же
 * репозиторий, откуда запускается сам скрипт.
 *
 * Этап "Выделение AI Worker в отдельный независимый сервис" сломал это
 * предположение: medizin-worker — ОТДЕЛЬНЫЙ репозиторий, физически на другом
 * сервере, без собственной копии контента сайта. Поэтому вызов
 * runSeoReviewStage() воркеру НЕОБХОДИМ доступ к актуальному Content
 * Registry, но "актуальный" для воркера означает "локальный git-чекаут сайта,
 * который воркер сам клонирует/обновляет" (см. medizin-worker/src/github/
 * content-checkout.mjs), а не "папка рядом со своим собственным кодом".
 *
 * РЕШЕНИЕ (требование пользователя "не дублировать код"): вместо второй копии
 * этого файла с другим способом вычисления ROOT — ОДНА реализация,
 * принимающая rootDir ЯВНЫМ параметром. И medizin (CLI-скрипты
 * content-check.mjs/content-find.mjs/generate-content-backlog-md.mjs), и
 * medizin-worker передают свой собственный корень явно — единственное, чем
 * они отличаются.
 *
 * Читает:
 *   - <rootDir>/src/content/categories (mdx frontmatter)
 *   - <rootDir>/src/content/symptoms, одна подпапка на раздел (mdx frontmatter)
 *   - <rootDir>/src/content/drugs (mdx frontmatter, плоская структура)
 *   - <rootDir>/src/data/content-registry.ids.json       (постоянные ID)
 *   - <rootDir>/src/data/content-registry.overrides.json (статус/качество/duplicateOf/заметки)
 *   - <rootDir>/src/data/content-registry.retired.json   (история объединённого/удалённого контента)
 *
 * Второй копии контента нигде нет. Если отредактировать title симптома в его
 * .mdx-файле — и сайт (Astro), и это чтение подхватят изменение автоматически
 * при следующем запуске/сборке — ничего здесь не нужно регенерировать вручную.
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
 *   и `src/data/content-registry.*.json`. У medizin это корень репозитория
 *   (обычно `<appDir>/current`); у medizin-worker — путь к локальному
 *   git-чекауту сайта (см. content-checkout.mjs).
 */
export function buildRegistry(rootDir) {
  if (!rootDir) throw new Error("buildRegistry(rootDir): rootDir обязателен — второй копии контента не существует, читаем только явно указанный чекаут.");

  const CAT_DIR = path.join(rootDir, "src/content/categories");
  const SYM_DIR = path.join(rootDir, "src/content/symptoms");
  const DRUG_DIR = path.join(rootDir, "src/content/drugs");
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
    const url = `/symptoms/${data.slug}`;
    const base = {
      id,
      title: typeof data.title === "object" ? data.title.ru : data.title,
      slug: data.slug,
      url,
      contentType: "symptom_category",
      status: "published",
      source: `src/content/categories/${file}`,
      canonical: url,
      inSitemap: true,
    };
    items.push({ ...base, ...(overrides[id] ?? {}) });
  }

  // --- symptoms ---
  const symptomFiles = listMdxFiles(SYM_DIR).sort();
  const seenSlugs = new Map();

  for (const full of symptomFiles) {
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
    const id = findId(ids, "symptom", key);
    if (!id) {
      problems.push(`No permanent ID for symptom "${key}" (file: ${rel})`);
      continue;
    }

    const url = `/symptoms/${data.category}/${data.slug}`;
    const isStub =
      Boolean(data.draft) || (typeof data.shortAnswer === "string" && data.shortAnswer.includes("Контент готовится"));

    const base = {
      id,
      title: data.title,
      slug: data.slug,
      url,
      contentType: "symptom",
      category: data.category,
      status: isStub ? "draft" : "published",
      source: rel,
      titleTag: data.seoTitle ?? `${data.title} — MEDIZIN.RU`,
      metaDescription: data.seoDescription ?? data.shortAnswer,
      h1: data.title,
      canonical: url,
      inSitemap: true,
      updatedAt: data.updated ? String(data.updated) : undefined,
      tags: data.tags ?? [],
      manualRelated: data.manualRelated ?? [],
      severity: data.severity,
      _raw: { data, body, file: rel },
    };
    items.push({ ...base, ...(overrides[id] ?? {}) });
  }

  // --- drugs (Раздел «Лекарства») — визуальная правка "категории каталога
  // лекарств" (июль 2026) переместила файлы в подпапки по терапевтической
  // категории (src/content/drugs/<category>/<slug>.mdx, folder = category,
  // та же конвенция, что и у symptoms/<category>/<slug>.mdx) и URL стал
  // вложенным /drugs/<category>/<slug>/. Постоянный Registry ID при этом
  // по-прежнему = голый slug БЕЗ category (см. findId ниже) — slug глобально
  // уникален среди лекарств вне зависимости от категории, в отличие от
  // symptoms, где ключ составной category/slug. ---
  if (fs.existsSync(DRUG_DIR)) {
    const drugFiles = listMdxFiles(DRUG_DIR).sort();
    const seenDrugSlugs = new Map();
    const allDrugSlugsForAnalogs = new Set();

    const parsedDrugs = drugFiles.map((full) => {
      const rel = path.relative(rootDir, full);
      const folder = path.basename(path.dirname(full));
      const { data, body } = readFrontmatter(full);
      allDrugSlugsForAnalogs.add(data.slug);
      return { full, rel, folder, data, body };
    });

    for (const { full, rel, folder, data, body } of parsedDrugs) {
      if (data.slug !== path.basename(full, ".mdx")) {
        problems.push(`Slug mismatch in ${rel}: frontmatter slug="${data.slug}" but filename is different`);
      }
      if (data.category !== folder) {
        problems.push(`Category/folder mismatch in ${rel}: category="${data.category}" but file lives in "${folder}/"`);
      }
      if (seenDrugSlugs.has(data.slug)) {
        problems.push(`DUPLICATE DRUG SLUG "${data.slug}": ${seenDrugSlugs.get(data.slug)} and ${rel}`);
      }
      seenDrugSlugs.set(data.slug, rel);

      for (const symSlug of data.appliesTo ?? []) {
        if (!seenSlugs.has(symSlug)) {
          problems.push(`Drug "${data.slug}" (${rel}) has appliesTo entry "${symSlug}" which does not exist among symptoms`);
        }
      }
      for (const analogSlug of data.analogSlugs ?? []) {
        if (analogSlug !== data.slug && !allDrugSlugsForAnalogs.has(analogSlug)) {
          problems.push(`Drug "${data.slug}" (${rel}) has analogSlugs entry "${analogSlug}" which does not exist among drugs`);
        }
      }

      const id = findId(ids, "drug", data.slug);
      if (!id) {
        problems.push(`No permanent ID for drug "${data.slug}" (file: ${rel})`);
        continue;
      }

      const url = `/drugs/${data.category}/${data.slug}`;
      const isStub =
        Boolean(data.draft) || (typeof data.shortDescription === "string" && data.shortDescription.includes("Контент готовится"));

      const base = {
        id,
        title: data.genericName,
        slug: data.slug,
        url,
        contentType: "drug",
        category: data.category,
        status: isStub ? "draft" : "published",
        source: rel,
        titleTag: data.seoTitle ?? `${data.genericName} — MEDIZIN.RU`,
        metaDescription: data.seoDescription ?? data.shortDescription,
        h1: data.genericName,
        canonical: url,
        inSitemap: true,
        updatedAt: data.updated ? String(data.updated) : undefined,
        tags: data.tags ?? [],
        tradeNames: data.tradeNames ?? [],
        _raw: { data, body, file: rel },
      };
      items.push({ ...base, ...(overrides[id] ?? {}) });
    }
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

  // --- retired entries (merged into / removed) — kept forever so content:find
  // still catches attempts to recreate a topic that was already resolved once ---
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

/**
 * Терапевтические категории каталога лекарств (src/content/drugCategories/*.mdx)
 * — лёгкое, отдельное от основного Registry чтение: у этих категорий пока
 * нет постоянных ID в content-registry.ids.json (в отличие от symptom
 * categories), поэтому они не являются полноценными ContentRegistryItem, а
 * просто списком {slug, title} для потребителей вроде AI-стратега (нужно
 * знать, в какие разделы каталога лекарств вообще можно предлагать темы).
 */
export function readDrugCategories(rootDir) {
  if (!rootDir) throw new Error("readDrugCategories(rootDir): rootDir обязателен.");
  const DIR = path.join(rootDir, "src/content/drugCategories");
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".mdx"))
    .sort()
    .map((f) => {
      const { data } = readFrontmatter(path.join(DIR, f));
      return { slug: data.slug, title: data.title };
    });
}
