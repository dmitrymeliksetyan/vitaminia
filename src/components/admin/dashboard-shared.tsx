import React from "react";
import {
  STATUS_LABELS as STATUS_LABELS_RAW,
  QUALITY_LABELS as QUALITY_LABELS_RAW,
  QUALITY_DESCRIPTIONS as QUALITY_DESCRIPTIONS_RAW,
} from "../../lib/content-registry/humanize.mjs";

// Общие форматирующие хелперы и мелкие UI-атомы — раньше жили как приватные
// функции внутри одного гигантского ContentDashboard.tsx (Этап 1.5-6),
// теперь используются и AI-редакцией (/admin/editorial/*), и Библиотекой
// контента (/admin/content*) — Этап 7 ТЗ разделил страницы, но не логику
// форматирования дат/денег/статусов, которая не привязана ни к одной из
// сторон.

export const QUALITY_LABELS = QUALITY_LABELS_RAW as Record<string, string>;
export const QUALITY_DESCRIPTIONS = QUALITY_DESCRIPTIONS_RAW as Record<string, string>;
export const STATUS_LABELS = STATUS_LABELS_RAW as Record<string, string>;

export const QUALITY_COLOR: Record<string, string> = {
  A: "var(--color-severity-low)",
  B: "var(--color-severity-medium)",
  C: "var(--color-severity-high)",
};

export const STATUS_COLOR: Record<string, string> = {
  published: "var(--color-severity-low)",
  draft: "var(--color-severity-medium)",
  planned: "var(--color-neutral-400)",
  duplicate: "var(--color-brand-blue)",
  merge: "var(--color-brand-blue)",
  update: "var(--color-severity-medium)",
  do_not_create: "var(--color-neutral-600)",
};

const APPROX_PRICE_IN = 3;
const APPROX_PRICE_OUT = 15;

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "50vh", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)", padding: "var(--space-4)" }}>
      {children}
    </div>
  );
}

// ТЗ "Убрать повторную проверку доступа и Load failed" — при переходе между
// разделами страница теперь может отрисоваться СРАЗУ по кэшированным данным
// (см. src/lib/admin/client-session-cache.ts), пока свежий ответ грузится в
// фоне. RefreshingHint — маленький ненавязчивый индикатор ЭТОГО фонового
// обновления (не блокирует интерфейс, не занимает весь экран — в отличие от
// прежнего полноэкранного "Проверка доступа…").
export function RefreshingHint({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)", marginBottom: "var(--space-3)" }}>
      <span style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid var(--color-border)", borderTopColor: "var(--color-brand-blue)", display: "inline-block", animation: "medizin-admin-spin 0.8s linear infinite" }} />
      Обновляем данные…
      <style>{"@keyframes medizin-admin-spin { to { transform: rotate(360deg); } }"}</style>
    </div>
  );
}

// Настоящая ошибка фонового обновления (в т.ч. "Load failed") — раньше
// любая ошибка fetch сбрасывала ВЕСЬ экран в phase='error', даже если на
// экране уже были рабочие данные с прошлой успешной загрузки. Теперь при
// наличии данных для показа используется этот баннер вместо полного
// сброса — интерфейс остаётся на месте, ошибка не скрывается молча (текст
// причины виден), а "Повторить" запускает загрузку заново без перезагрузки
// страницы.
export function RetryBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", background: "var(--color-bg-warning)", border: "1px solid var(--color-border-warning)", borderRadius: "var(--radius-md)", padding: "8px 14px", marginBottom: "var(--space-4)", fontSize: "var(--font-size-xs)", color: "var(--color-text)" }}>
      <span>Не удалось обновить данные: {message}</span>
      <button
        onClick={onRetry}
        style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", padding: "5px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border)", background: "#fff", cursor: "pointer" }}
      >
        Повторить
      </button>
    </div>
  );
}

export function BigStat({
  label, value, suffix, hint, color, onClick,
}: {
  label: string; value: number | string; suffix?: string; hint?: string; color?: string; onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "#fff",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-4)",
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>{label}</div>
      <div style={{ fontSize: "var(--font-size-xl)", fontWeight: "var(--font-weight-semibold)", color: color ?? "var(--color-text)" }}>
        {value}
        {suffix && <span style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--font-weight-regular)", color: "var(--color-text-secondary)", marginLeft: 6 }}>{suffix}</span>}
      </div>
      {hint && <div style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>{hint}</div>}
    </button>
  );
}

export function LinkStat({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--color-brand-blue)", cursor: "pointer", textDecoration: "underline" }}
    >
      {children}
    </button>
  );
}

export function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: "var(--font-size-sm)",
        padding: "6px 14px",
        borderRadius: "var(--radius-md)",
        border: "none",
        background: active ? "#fff" : "transparent",
        color: active ? "var(--color-brand-blue)" : "var(--color-text-secondary)",
        fontWeight: active ? "var(--font-weight-medium)" : "var(--font-weight-regular)",
        cursor: "pointer",
        boxShadow: active ? "var(--shadow-sm)" : "none",
      }}
    >
      {children}
    </button>
  );
}

export function QualityBadge({ quality }: { quality?: string }) {
  if (!quality) {
    return <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-neutral-400)" }}>Без оценки</span>;
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: "var(--font-size-xs)",
        fontWeight: "var(--font-weight-medium)",
        color: QUALITY_COLOR[quality] ?? "var(--color-text)",
      }}
      title={QUALITY_DESCRIPTIONS[quality]}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: QUALITY_COLOR[quality] ?? "var(--color-neutral-400)", display: "inline-block" }} />
      {quality} — {QUALITY_LABELS[quality] ?? quality}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-medium)", color: STATUS_COLOR[status] ?? "var(--color-text-secondary)" }}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function OpenLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      style={{
        fontSize: "var(--font-size-xs)",
        color: "var(--color-brand-blue)",
        border: "1px solid var(--color-border-info)",
        background: "var(--color-bg-info)",
        borderRadius: "var(--radius-sm)",
        padding: "3px 8px",
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      Открыть ↗
    </a>
  );
}

export function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        fontSize: "var(--font-size-sm)",
        padding: "6px 10px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border)",
        background: "#fff",
        color: "var(--color-text)",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Panel({ tone, title, children }: { tone: "ok" | "warn" | "neutral"; title: string; children: React.ReactNode }) {
  const bg = tone === "ok" ? "var(--color-bg-info)" : tone === "warn" ? "var(--color-bg-warning)" : "#fff";
  const border = tone === "ok" ? "var(--color-border-info)" : tone === "warn" ? "var(--color-border-warning)" : "var(--color-border)";
  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: "var(--radius-lg)", padding: "var(--space-4)", marginBottom: "var(--space-3)" }}>
      <div style={{ fontSize: "var(--font-size-md)", fontWeight: "var(--font-weight-semibold)", color: "var(--color-text)", marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function estimateCostFallback(inTok: number, outTok: number): number {
  return (inTok / 1_000_000) * APPROX_PRICE_IN + (outTok / 1_000_000) * APPROX_PRICE_OUT;
}

export function computeJobCostSummary(runs: any[]) {
  const perStage = new Map<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }>();
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  let firstStart: string | null = null;
  let lastEnd: string | null = null;

  for (const r of runs) {
    const inTok = r.usage_input_tokens ?? 0;
    const outTok = r.usage_output_tokens ?? 0;
    const cost = r.cost_usd != null ? Number(r.cost_usd) : estimateCostFallback(inTok, outTok);
    const duration = r.duration_ms ?? 0;

    totalCostUsd += cost;
    totalInputTokens += inTok;
    totalOutputTokens += outTok;
    totalDurationMs += duration;

    const entry = perStage.get(r.stage) ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
    entry.calls += 1;
    entry.inputTokens += inTok;
    entry.outputTokens += outTok;
    entry.costUsd += cost;
    entry.durationMs += duration;
    perStage.set(r.stage, entry);

    if (r.started_at && (!firstStart || r.started_at < firstStart)) firstStart = r.started_at;
    if (r.completed_at && (!lastEnd || r.completed_at > lastEnd)) lastEnd = r.completed_at;
  }

  return { perStage, totalCostUsd, totalInputTokens, totalOutputTokens, totalDurationMs, totalCalls: runs.length, firstStart, lastEnd };
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function fmtDurationShort(ms: number): string {
  if (!ms || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min} мин ${sec} с` : `${sec} с`;
}

export function budgetBarColor(spent: number, limit: number): string {
  if (spent >= limit) return "var(--color-brand-red)";
  if (spent >= limit * 0.6) return "var(--color-brand-orange, #d97706)";
  if (spent >= limit * 0.24) return "var(--color-brand-blue)";
  return "var(--color-severity-low)";
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return iso;
  }
}

export function tierStars(score: number): string {
  if (score >= 80) return "★★★★★";
  if (score >= 60) return "★★★★";
  return "★★★";
}
