/**
 * Багфикс «пустой экран при открытии производства» — TypeError:
 * "redFlags.map is not a function".
 *
 * Форк normalize-job.mjs из medizin-shared, упрощён под единственный тип
 * контента Vitaminia (nutrient, см. src/content.config.ts::nutrients) — нет
 * drug-ветки, нет content_type-развилки.
 *
 * Используется ОБЕИМИ сторонами после разделения на vitaminia-live (SSR)/
 * vitaminia-worker:
 *   - vitaminia-live читает эту функцию в GET-роутах (/api/admin/content/jobs,
 *     /api/admin/content/jobs/[id], retry-stage.ts, extend-budget.ts,
 *     check-deploy.ts, revise.ts) — чтобы то, что видит администратор в
 *     браузере, было гарантированно рендерибельным независимо от того, кто и
 *     когда записал job (человек, старый вызов, воркер);
 *   - vitaminia-worker вызывает её же в run-stage.ts после каждого этапа
 *     перед тем, как вернуть outcome вызывающему коду — та же самая гарантия
 *     формы данных, без второй копии логики.
 */

export function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeObjectArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

// Нутриент-frontmatter (src/content.config.ts::nutrients) — гарантирует, что
// любое поле, которое где-либо в JobScreen проходит через `.map()`, после
// этой функции ТОЧНО массив.
function normalizeNutrientFrontmatter(fm) {
  return {
    ...fm,
    otherNames: normalizeStringArray(fm.otherNames),
    whatIsItFor: normalizeStringArray(fm.whatIsItFor),
    benefits: normalizeStringArray(fm.benefits),
    deficiencySigns: normalizeStringArray(fm.deficiencySigns),
    excessSigns: normalizeStringArray(fm.excessSigns),
    foodSources: normalizeStringArray(fm.foodSources),
    dailyIntake: normalizeStringArray(fm.dailyIntake),
    supplementForms: normalizeStringArray(fm.supplementForms),
    contraindications: normalizeStringArray(fm.contraindications),
    tags: normalizeStringArray(fm.tags),
    manualRelated: normalizeStringArray(fm.manualRelated),
    sources: normalizeObjectArray(fm.sources),
    faq: normalizeObjectArray(fm.faq),
  };
}

export function normalizeJobDetail(job) {
  if (!job) return job;

  const fm = job.draft?.frontmatter;
  const draft = job.draft
    ? {
        ...job.draft,
        frontmatter: fm ? normalizeNutrientFrontmatter(fm) : fm,
      }
    : job.draft;

  const rb = job.research_brief;
  const researchBrief = rb
    ? {
        ...rb,
        userIntent: normalizeStringArray(rb.userIntent),
        contraindicationFlags: normalizeStringArray(rb.contraindicationFlags),
        diagnosticQuestions: normalizeStringArray(rb.diagnosticQuestions),
        relatedNutrientSlugs: normalizeStringArray(rb.relatedNutrientSlugs),
        benefitGroups: Array.isArray(rb.benefitGroups)
          ? rb.benefitGroups
          : typeof rb.benefitGroups === "string" && rb.benefitGroups.trim()
            ? [{ group: "Beneficios", description: rb.benefitGroups.trim() }]
            : [],
        sources: normalizeObjectArray(rb.sources),
      }
    : rb;

  const mr = job.medical_review;
  const medicalReview = mr
    ? {
        ...mr,
        problems: normalizeObjectArray(mr.problems),
        claims: normalizeObjectArray(mr.claims),
        criticalIssues: normalizeObjectArray(mr.criticalIssues),
        warnings: normalizeObjectArray(mr.warnings),
        appliedFixes: normalizeObjectArray(mr.appliedFixes),
        unappliedFixes: normalizeObjectArray(mr.unappliedFixes),
        fixInstructions: normalizeStringArray(mr.fixInstructions),
      }
    : mr;

  const sr = job.seo_review;
  const seoReview = sr
    ? {
        ...sr,
        criticalIssues: normalizeStringArray(sr.criticalIssues),
        warnings: normalizeStringArray(sr.warnings),
        duplicateCandidates: normalizeObjectArray(sr.duplicateCandidates),
      }
    : sr;

  return { ...job, draft, research_brief: researchBrief, medical_review: medicalReview, seo_review: seoReview };
}
