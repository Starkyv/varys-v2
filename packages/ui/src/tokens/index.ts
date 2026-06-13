/**
 * Token barrel — the design system's source of truth in TypeScript.
 * Import for JS-land consumers (charts, inline styles, the extension overlay):
 *
 *   import { colors, space, dataViz } from "@varys/ui/tokens";
 *
 * For styling components, prefer the CSS custom properties in `themes/_tokens.scss`
 * (`var(--color-primary)`) so theming (dark / per-brand) works automatically.
 */
export * from "./colors";
export * from "./spacing";
export * from "./typography";
export * from "./radii";
export * from "./shadows";
export * from "./motion";
export * from "./breakpoints";
export * from "./zIndex";

import { colors } from "./colors";
import { space } from "./spacing";
import { typography } from "./typography";
import { radius } from "./radii";
import { shadow } from "./shadows";
import { motion } from "./motion";
import { breakpoint } from "./breakpoints";
import { zIndex } from "./zIndex";

export const tokens = {
  colors,
  space,
  typography,
  radius,
  shadow,
  motion,
  breakpoint,
  zIndex,
} as const;
