/**
 * Color tokens — the raw palette + semantic aliases for the "Nexus" visual language.
 *
 * Source of truth lives here (TypeScript) for JS-land consumers: charts/data-viz,
 * the `Nav` inline styles, and the extension's Shadow-DOM `<style>`. The same values
 * are mirrored as CSS custom properties in `themes/_tokens.scss` — keep the two in sync
 * (the SCSS file is the contract components consume via `var(--color-…)`).
 *
 * Primitive ramps are theme-independent. Semantic aliases (`semanticLight`) are what
 * UI should reference; dark/brand themes re-point the same aliases.
 */

/** Brand violet — anchored on #5347CE from the brand guide; #887CFD is the 400 step. */
export const brand = {
  50: "#EEECFB",
  100: "#DCD8F7",
  200: "#BDB4F0",
  300: "#A294F2",
  400: "#887CFD",
  500: "#5347CE",
  600: "#4539B5",
  700: "#382E94",
  800: "#2C2474",
  900: "#211B57",
} as const;

/** Accent blue — #4896FE from the brand guide. */
export const blue = {
  50: "#E8F1FF",
  100: "#CDE2FF",
  200: "#9FC8FF",
  300: "#71AEFF",
  400: "#4896FE",
  500: "#1B6FD6",
  600: "#1559AC",
} as const;

/** Accent teal — #16C8C7 from the brand guide; 300 is the light-teal chart tint. */
export const teal = {
  50: "#E2F7F5",
  100: "#BFefec",
  200: "#7EE0D6",
  300: "#3DD6CE",
  400: "#16C8C7",
  500: "#0FA6A5",
  600: "#0B8281",
} as const;

/** Cool-grey neutral ramp — read off the dashboard surfaces & text. */
export const neutral = {
  0: "#FFFFFF",
  25: "#FBFBFC",
  50: "#F6F7F9",
  100: "#EEF0F4",
  150: "#E7EAEF",
  200: "#DDE1E8",
  300: "#C7CCD6",
  400: "#A0A6B2",
  500: "#8A909E",
  600: "#646B7A",
  700: "#454B58",
  800: "#2A2F3A",
  900: "#1A1D29",
  950: "#101322",
} as const;

/** Status ramps (derived — not in the brand guide; tuned to the delta badges). */
export const green = { soft: "#E2F6F0", base: "#0EA47F", fg: "#0B8568" } as const;
export const amber = { soft: "#FEF3DA", base: "#F5A524", fg: "#B5710F" } as const;
export const red = { soft: "#FDE7EB", base: "#F0445E", fg: "#D32F49" } as const;
export const sky = { soft: "#E8F1FF", base: "#4896FE", fg: "#1B6FD6" } as const;

/**
 * Categorical data-viz scale — the legend sequence from the Sales Overview chart
 * (China / UE / USA / Canada / Other). Use in order for series colors.
 */
export const dataViz = [
  brand[500], // #5347CE
  brand[400], // #887CFD
  blue[400], // #4896FE
  teal[400], // #16C8C7
  teal[200], // #7EE0D6
] as const;

/**
 * Semantic aliases for the default (light) theme. UI references these names;
 * themes/brands re-point them. Mirrored in `themes/_tokens.scss` & `light.scss`.
 */
export const semanticLight = {
  // Surfaces
  bgPage: neutral[100],
  bgSurface: neutral[0],
  bgSubtle: neutral[50],
  bgInset: neutral[100],
  // Borders
  border: neutral[150],
  borderStrong: neutral[200],
  // Text
  textStrong: neutral[950],
  text: neutral[700],
  textMuted: neutral[500],
  textSubtle: neutral[400],
  textOnPrimary: neutral[0],
  // Primary (interactive)
  primary: brand[500],
  primaryHover: brand[600],
  primaryActive: brand[700],
  primarySoft: brand[50],
  primaryFg: neutral[0],
  // Accents
  accentBlue: blue[400],
  accentTeal: teal[400],
  // Status
  success: green.base,
  successSoft: green.soft,
  successFg: green.fg,
  warning: amber.base,
  warningSoft: amber.soft,
  warningFg: amber.fg,
  danger: red.base,
  dangerSoft: red.soft,
  dangerFg: red.fg,
  info: sky.base,
  infoSoft: sky.soft,
  infoFg: sky.fg,
  // Focus
  focusRing: "rgba(83, 71, 206, 0.32)",
} as const;

export type SemanticColor = keyof typeof semanticLight;

export const colors = {
  brand,
  blue,
  teal,
  neutral,
  green,
  amber,
  red,
  sky,
  dataViz,
  semantic: semanticLight,
} as const;
