// theme.ts — типизированная обёртка над theme.mjs.
// Сами значения живут в .mjs (чтобы их мог импортировать без транспиляции
// tailwind.config.mjs и scripts/generate-tokens.mjs), этот файл только даёт типы
// для использования токенов внутри .astro/.ts кода.

import theme, { colors, spacing, radii, typography, shadows, containers, icons } from "./theme.mjs";

export type ColorScale = typeof colors;
export type SpacingScale = typeof spacing;
export type RadiiScale = typeof radii;
export type TypographyScale = typeof typography;
export type ShadowScale = typeof shadows;
export type ContainerScale = typeof containers;
export type IconName = keyof typeof icons;

export { colors, spacing, radii, typography, shadows, containers, icons };
export default theme;
