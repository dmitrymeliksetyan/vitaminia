/**
 * Design tokens — единственный источник истины.
 */

export const colors = {
  text: "#1a1a2e",
  "text-secondary": "#5a6272",
  border: "#e8eaed",

  // Marca — de las 4 esquinas del logotipo de Vitaminia
  "brand-orange": "#F5821F",   // salud
  "brand-orange-light": "#FDB515", // longevidad (ámbar)
  "brand-green": "#5DB53D",    // cuidado / naturaleza
  "brand-teal": "#00A19A",     // amor / bienestar
  "brand-blue": "#00A19A",     // alias retro-compatible (antes azul MEDIZIN)
  "brand-blue-light": "#5DB53D",
  "brand-red": "#F5821F",      // alias retro-compatible (antes rojo MEDIZIN)
  "brand-red-light": "#FDB515",

  // Escala neutra de estado (ya no "severidad médica")
  "severity-low": "#2e7d32",
  "severity-medium": "#ed6c02",
  "severity-high": "#c62828",
  "scale-inactive": "#e8eaed",

  // Callout-боксы
  "bg-info": "#eef4fb",
  "border-info": "#b6d4f0",
  "bg-warning": "#fff6e5",
  "border-warning": "#f0d29b",
  "bg-danger": "#fdecec",
  "border-danger": "#f0b3b3",

  // Нейтральная шкала
  "neutral-0": "#ffffff",
  "neutral-50": "#f8f9fb",
  "neutral-100": "#f1f3f6",
  "neutral-200": "#e8eaed",
  "neutral-400": "#9aa3b2",
  "neutral-600": "#5a6272",
  "neutral-800": "#2c3347",
  "neutral-900": "#1a1a2e",

  "accent-default": "#5DB53D"
};

export const spacing = {
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  5: "1.25rem",
  6: "1.5rem",
  8: "2rem",
  12: "3rem",
  16: "4rem"
};

export const radii = {
  sm: "2px",
  md: "8px",
  lg: "12px",
  full: "999px"
};

export const typography = {
  fontFamily: {
    sans: "'Inter', system-ui, -apple-system, sans-serif"
  },
  fontSize: {
    xs: "0.75rem",
    sm: "0.875rem",
    md: "1rem",
    lg: "1.125rem",
    xl: "1.375rem",
    "2xl": "1.75rem",
    "3xl": "2.25rem"
  },
  lineHeight: {
    tight: "1.25",
    normal: "1.5",
    relaxed: "1.7"
  },
  fontWeight: {
    regular: "400",
    medium: "500",
    semibold: "600",
    bold: "700"
  }
};

export const shadows = {
  sm: "0 1px 3px rgba(93, 181, 61, 0.06)",
  md: "0 4px 16px rgba(93, 181, 61, 0.08)",
  lg: "0 12px 40px rgba(93, 181, 61, 0.12)"
};

export const containers = {
  content: "720px",
  wide: "1100px"
};

export const icons = {
  droplet:
    '<path d="M12 3 Q18 10 18 15a6 6 0 0 1-12 0Q6 10 12 3Z" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  mineral:
    '<path d="M12 2 L20 8.5 17 21H7L4 8.5Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 8.5h16M9 2 7 21M15 2l2 19" fill="none" stroke="currentColor" stroke-width="1"/>',
  leaf:
    '<path d="M5 20c9 1 14-4 14-14C10 6 5 11 5 20Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 19c3-4 6-7 12-12" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  pill:
    '<rect x="3" y="9" width="18" height="6" rx="3" fill="none" stroke="currentColor" stroke-width="1.5" transform="rotate(-30 12 12)"/><path d="M9 8.5 15 15.5" stroke="currentColor" stroke-width="1.5"/>',
  heart:
    '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  bone:
    '<path d="M6 6a3 3 0 0 1 6 0v1h4V6a3 3 0 0 1 6 0 3 3 0 0 1-3 3h-1v4h1a3 3 0 0 1 0 6 3 3 0 0 1-3-3v-1H12v1a3 3 0 0 1-6 0 3 3 0 0 1 3-3h1v-4H9a3 3 0 0 1-3-3Z" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  brain:
    '<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5h8a3 3 0 0 0 2-5 3 3 0 0 0-2-5 3 3 0 0 0-3-3Z" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  shield:
    '<path d="M12 3 L20 7v6c0 4-3.5 7.7-8 9-4.5-1.3-8-5-8-9V7Z" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  hourglass:
    '<path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  apple:
    '<path d="M12 8c-3 0-6 2.5-6 7 0 4 2.5 6 4.5 6 1 0 1.5-.5 2-.5s1 .5 2 .5C16.5 21 19 19 19 15c0-4.5-3-7-6-7Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 8c0-2 1-3.5 2.5-4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  scale:
    '<path d="M12 3v18M6 7h12M6 7 3 13a3 3 0 0 0 6 0Zm12 0-3 6a3 3 0 0 0 6 0Z" fill="none" stroke="currentColor" stroke-width="1.5"/>'
};

export const theme = { colors, spacing, radii, typography, shadows, containers, icons };
export default theme;
