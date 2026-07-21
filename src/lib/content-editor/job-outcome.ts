// AI-редакция — самостоятельность и новая навигация (см. финальный отчёт).
//
// Раньше ЛЮБАЯ находка медредактора (даже "смягчить одну фразу") в итоге
// заканчивалась статусом needs_decision — человек был обязан кликнуть,
// даже когда в статье нет ни одной реальной медицинской проблемы (п.8 ТЗ:
// "AI не должен обращаться к человеку из-за обычных редакторских
// замечаний"). Функция ниже — ЕДИНАЯ точка, которая решает, остановилось
// ли производство по-настоящему (нужен человек) или это просто финальный
// результат с примечаниями/без них (можно публиковать). Используется и на
// сервере (advance.ts — что писать в decision_reason/status), и на клиенте
// (JobScreen/AiEditorialHub — что показать администратору), чтобы то и
// другое никогда не расходилось.
//
// Критично: computeJobOutcome — ЧИСТАЯ функция от уже сохранённых данных
// job (criticalCount/needsAttentionCount и т.п.). Она НЕ вызывает AI и не
// стоит ни цента — именно поэтому пересчёт статуса существующих jobs (п.13
// ТЗ) не требует новых платных вызовов: достаточно, чтобы job.medical_review
// содержал счётчики (см. normalize-job.ts и ручной перенос исторических
// данных для "Онемение пальцев рук" в финальном отчёте).

// Терминология ТЗ "автономное производство статей и снижение стоимости"
// (п.4) использует слова ready/ready_with_notes/blocked. Здесь эти три
// значения ОДНОЗНАЧНО соответствуют уже существующим done/done_with_notes/
// needs_human — переименование самого типа НЕ делалось намеренно (см.
// финальный отчёт: JobOutcome — потребляется в 8+ местах EditorialApp.tsx/
// decision.ts/revise.ts/advance.ts как строковые литералы "needs_decision" и
// т.п., полное переименование дало бы большой риск при нулевой пользе,
// раз поведение уже 1:1 совпадает с новым ТЗ). Соответствие:
//   ready            === "done"
//   ready_with_notes === "done_with_notes"
//   blocked          === "needs_human"
export type JobOutcome =
  | "in_progress" // этап ещё выполняется, конечного результата пока нет
  | "needs_human" // = "blocked" по терминологии нового ТЗ — реальная медицинская/техническая проблема, дальше только человек
  | "done" // = "ready" — критических проблем нет, примечаний нет — можно публиковать
  | "done_with_notes" // = "ready_with_notes" — критических проблем нет, есть некритические примечания — можно публиковать
  | "stopped_budget" // остановлено жёстким денежным лимитом (Этап 3.2)
  | "terminal"; // rejected/archived/published/approved — решение уже принято человеком

/** Литералы нового ТЗ — для кода/логов, которые хотят именно эти слова, без переименования самого типа выше. */
export const JOB_OUTCOME_TZ_ALIAS: Record<JobOutcome, string> = {
  in_progress: "in_progress",
  needs_human: "blocked",
  done: "ready",
  done_with_notes: "ready_with_notes",
  stopped_budget: "stopped_budget",
  terminal: "terminal",
};

/**
 * criticalCount > 0 — ЕДИНСТВЕННОЕ, что должно останавливать производство
 * (п.6 ТЗ, п.3 нового ТЗ). Всё остальное (warnings/needsAttentionCount, seo
 * warnings, "статья не идеальна") не блокирует — AI решает сам (п.7-8 ТЗ).
 *
 * Поддерживает ОБЕ формы job.medical_review — старую (числа confirmedCount/
 * needsAttentionCount/criticalCount + problems[], до объединения медпроверки
 * и автоправки в один вызов) и новую (массивы criticalIssues[]/warnings[]/
 * appliedFixes[] из Вызова 3 нового ТЗ) — чтобы старые уже завершённые job
 * не потеряли корректное отображение статуса после этого рефакторинга.
 */
function countCritical(mr: any): number {
  if (!mr) return 0;
  if (Array.isArray(mr.criticalIssues)) return mr.criticalIssues.length;
  return Number(mr.criticalCount ?? 0);
}
function countNeedsAttention(mr: any): number {
  if (!mr) return 0;
  if (Array.isArray(mr.warnings)) return mr.warnings.length;
  return Number(mr.needsAttentionCount ?? 0);
}

export function computeJobOutcome(job: any): JobOutcome {
  if (!job) return "in_progress";
  if (job.status === "paused" && job.stop_reason_code === "hard_limit") return "stopped_budget";
  if (job.status === "published" || job.status === "approved" || job.status === "rejected" || job.status === "archived") return "terminal";

  if (job.status === "needs_decision") {
    if (job.current_stage !== "done") {
      // Остановка ДО завершения всех этапов — либо реальная критическая
      // медицинская проблема, либо техническая (не удалось создать
      // черновик/исследование после лимита попыток). В обоих случаях это
      // по определению "нужен человек" (=blocked) — дальше пути без него нет.
      return "needs_human";
    }
    // current_stage === 'done': все этапы пройдены, включая SEO. Публикация
    // разрешена (п.6 ТЗ) — различаем только "чисто" или "с примечаниями".
    const needsAttention = countNeedsAttention(job.medical_review);
    const seoWarnings = Array.isArray(job.seo_review?.warnings) ? job.seo_review.warnings.length : 0;
    return needsAttention > 0 || seoWarnings > 0 ? "done_with_notes" : "done";
  }

  return "in_progress";
}

export const OUTCOME_LABELS: Record<JobOutcome, string> = {
  in_progress: "В работе",
  needs_human: "Нужен человек",
  done: "Готово",
  done_with_notes: "Готово с замечаниями",
  stopped_budget: "Остановлено по бюджету",
  terminal: "Решение принято",
};

export const OUTCOME_COLORS: Record<JobOutcome, string> = {
  in_progress: "var(--color-brand-blue)",
  needs_human: "var(--color-brand-red)",
  done: "var(--color-severity-low)",
  done_with_notes: "var(--color-severity-low)",
  stopped_budget: "var(--color-brand-red)",
  terminal: "var(--color-text-secondary)",
};

/** Короткое человекочитаемое резюме для правой панели экрана производства (п.5 ТЗ примера). */
export function summarizeOutcome(job: any): string {
  const mr = job.medical_review;
  const confirmed = mr?.confirmedCount ?? 0;
  const attention = countNeedsAttention(mr);
  const critical = countCritical(mr);
  if (job.current_stage !== "done" && job.status === "needs_decision") {
    return job.decision_reason ?? "Требуется решение человека.";
  }
  const parts: string[] = [];
  if (confirmed > 0) parts.push(`${confirmed} утвержден${confirmed === 1 ? "о" : confirmed < 5 ? "ы" : "о"}`);
  if (attention > 0) parts.push(`${attention} формулировк${attention === 1 ? "у" : "и"} можно улучшить`);
  parts.push(critical > 0 ? `критических проблем: ${critical}` : "Критических проблем нет.");
  return parts.join(". ") + (critical === 0 ? " Статья безопасна для публикации." : "");
}
