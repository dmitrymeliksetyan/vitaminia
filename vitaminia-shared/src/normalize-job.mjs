/**
 * Багфикс «пустой экран при открытии производства» — TypeError:
 * "redFlags.map is not a function".
 *
 * Раньше жил как src/lib/content-editor/normalize-job.ts внутри medizin.
 * Используется ОБЕИМИ сторонами после разделения на medizin (SSR)/medizin-worker:
 *   - medizin читает эту функцию в GET-роутах (/api/admin/content/jobs,
 *     /api/admin/content/jobs/[id], retry-stage.ts, extend-budget.ts,
 *     check-deploy.ts, revise.ts) — чтобы то, что видит администратор в
 *     браузере, было гарантированно рендерибельным независимо от того, кто и
 *     когда записал job (человек, старый вызов, воркер);
 *   - medizin-worker вызывает её же в run-stage.ts после каждого этапа перед
 *     тем, как вернуть outcome вызывающему коду (см. queue-worker.mjs) — та
 *     же самая гарантия формы данных, без второй копии логики.
 *
 * Перенесено в общий пакет medizin-shared (plain ESM, без TS) по явному
 * требованию не дублировать код между SSR и Worker.
 */

export function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeObjectArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

/**
 * Приводит одну job-запись (+ вложенные draft/research_brief/medical_review/
 * seo_review) к гарантированно рендерибельной форме: любое поле, которое
 * где-либо в JobScreen проходит через `.map()`, после этой функции ТОЧНО
 * массив (пустой, если исходные данные были не тем, что ожидалось).
 */
// Раздел «Лекарства» — те же гарантии массивов, но для drug-frontmatter
// (src/content.config.ts::drugs в medizin, отдельная схема от symptoms).
// genericName как fallback-признак (в дополнение к content_type) — если
// поле почему-то не проставлено, а frontmatter уже явно "лекарственный" по
// форме, всё равно нормализуем правильным набором полей, а не symptom-набором.
function normalizeDrugFrontmatter(fm) {
  return {
    ...fm,
    tradeNames: normalizeStringArray(fm.tradeNames),
    mainExplanation: normalizeStringArray(fm.mainExplanation),
    quickFacts: normalizeObjectArray(fm.quickFacts),
    appliesTo: normalizeStringArray(fm.appliesTo),
    whenHelps: normalizeStringArray(fm.whenHelps),
    whenNotHelp: normalizeStringArray(fm.whenNotHelp),
    howToTake: normalizeStringArray(fm.howToTake),
    sideEffects: normalizeObjectArray(fm.sideEffects),
    contraindications: normalizeStringArray(fm.contraindications),
    interactions: normalizeStringArray(fm.interactions),
    analogSlugs: normalizeStringArray(fm.analogSlugs),
    relatedConditionSlugs: normalizeStringArray(fm.relatedConditionSlugs),
    tags: normalizeStringArray(fm.tags),
    faq: normalizeObjectArray(fm.faq),
  };
}

export function normalizeJobDetail(job) {
  if (!job) return job;

  const fm = job.draft?.frontmatter;
  const isDrug = job.content_type === "drug" || Boolean(fm && typeof fm === "object" && "genericName" in fm);
  const draft = job.draft
    ? {
        ...job.draft,
        frontmatter: fm
          ? isDrug
            ? normalizeDrugFrontmatter(fm)
            : {
                ...fm,
                keyPoints: normalizeStringArray(fm.keyPoints),
                causes: normalizeStringArray(fm.causes),
                selfCare: normalizeStringArray(fm.selfCare),
                whenToSeeDoctor: normalizeStringArray(fm.whenToSeeDoctor),
                whenUrgent: normalizeStringArray(fm.whenUrgent),
                tags: normalizeStringArray(fm.tags),
                manualRelated: normalizeStringArray(fm.manualRelated),
                faq: normalizeObjectArray(fm.faq),
              }
          : fm,
      }
    : job.draft;

  const rb = job.research_brief;
  const researchBrief = rb
    ? {
        ...rb,
        userIntent: normalizeStringArray(rb.userIntent),
        redFlags: normalizeStringArray(rb.redFlags),
        diagnosticQuestions: normalizeStringArray(rb.diagnosticQuestions),
        relatedSymptomSlugs: normalizeStringArray(rb.relatedSymptomSlugs),
        causeGroups: Array.isArray(rb.causeGroups)
          ? rb.causeGroups
          : typeof rb.causeGroups === "string" && rb.causeGroups.trim()
            ? [{ group: "Причины", description: rb.causeGroups.trim() }]
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
