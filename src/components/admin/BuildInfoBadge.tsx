import React, { useEffect, useRef, useState } from "react";
import { BUILD_INFO } from "../../generated/build-info";

// ТЗ "Build Info в админке" — уникальный идентификатор сборки, видимый на
// любом скриншоте админки: "по любому скриншоту сразу понять, какая именно
// версия приложения сейчас запущена". Данные приходят из src/generated/build-info.ts,
// который перегенерируется заново на КАЖДОЙ сборке (scripts/generate-build-info.mjs)
// — здесь только форматирование и отображение, никакой логики вычисления
// версии/коммита/окружения (единственный источник правды — сам build-info.ts).

const ENV_SHORT_LABEL: Record<string, string> = { local: "Local", preview: "Preview", production: "Prod" };
const ENV_FULL_LABEL: Record<string, string> = { local: "Local", preview: "Preview", production: "Production" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Формат из ТЗ дословно: "11 Jul 23:48".
function formatShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Формат из ТЗ дословно (модальное окно): "11 Jul 2026 23:48 UTC".
function formatFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export default function BuildInfoBadge() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const envShort = ENV_SHORT_LABEL[BUILD_INFO.environment] ?? BUILD_INFO.environment;
  const envFull = ENV_FULL_LABEL[BUILD_INFO.environment] ?? BUILD_INFO.environment;

  const rows: Array<[string, string]> = [
    ["Version:", BUILD_INFO.version],
    ["Commit:", BUILD_INFO.commit],
    ["Branch:", BUILD_INFO.branch],
    ["Environment:", envFull],
    ["Build time:", formatFull(BUILD_INFO.buildTime)],
    ["Astro:", BUILD_INFO.astroVersion],
    ["Node:", BUILD_INFO.nodeVersion],
  ];

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Build info"
        style={{
          fontSize: "11px",
          lineHeight: 1.4,
          color: "#8B8B8B",
          background: "none",
          border: "none",
          padding: "10px 2px",
          cursor: "pointer",
          fontFamily: "inherit",
          whiteSpace: "nowrap",
        }}
      >
        v{BUILD_INFO.version} • {BUILD_INFO.commit} • {formatShort(BUILD_INFO.buildTime)} • {envShort}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 50,
            background: "#fff",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            padding: "var(--space-3) var(--space-4)",
            minWidth: 220,
          }}
        >
          {rows.map(([label, value]) => (
            <div key={label} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: "10px", color: "var(--color-text-secondary)" }}>{label}</div>
              <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text)", fontWeight: "var(--font-weight-medium)" }}>{value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
