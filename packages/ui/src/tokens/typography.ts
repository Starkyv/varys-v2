/**
 * Typography tokens — SF Pro Display per the brand guide, with a graceful system
 * fallback (the font is not bundled: Apple licensing). Weights 400/500/600/700.
 */

export const fontFamily = {
  display:
    '"SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
  text: '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

/** Type scale, rem (root 16px): 12 → 36px. */
export const fontSize = {
  xs: "0.75rem", // 12
  sm: "0.8125rem", // 13
  base: "0.875rem", // 14 — body default
  md: "1rem", // 16
  lg: "1.125rem", // 18
  xl: "1.25rem", // 20
  "2xl": "1.5rem", // 24
  "3xl": "1.875rem", // 30
  "4xl": "2.25rem", // 36
} as const;

export const lineHeight = {
  tight: "1.2",
  snug: "1.35",
  normal: "1.5",
  relaxed: "1.65",
} as const;

export const letterSpacing = {
  tight: "-0.01em",
  normal: "0",
  wide: "0.04em", // uppercase labels / overlines
} as const;

/**
 * Composite text roles — what UI should reach for instead of raw size/weight.
 * Maps to the dashboard: `displayLg`=big KPI numbers, `overline`=GENERAL/TOOLS labels.
 */
export const textStyle = {
  displayLg: { fontSize: fontSize["3xl"], lineHeight: lineHeight.tight, fontWeight: fontWeight.bold, letterSpacing: letterSpacing.tight },
  h1: { fontSize: fontSize["2xl"], lineHeight: lineHeight.tight, fontWeight: fontWeight.bold, letterSpacing: letterSpacing.tight },
  h2: { fontSize: fontSize.xl, lineHeight: lineHeight.snug, fontWeight: fontWeight.semibold, letterSpacing: letterSpacing.normal },
  h3: { fontSize: fontSize.md, lineHeight: lineHeight.snug, fontWeight: fontWeight.semibold, letterSpacing: letterSpacing.normal },
  bodyLg: { fontSize: fontSize.md, lineHeight: lineHeight.normal, fontWeight: fontWeight.regular, letterSpacing: letterSpacing.normal },
  body: { fontSize: fontSize.base, lineHeight: lineHeight.normal, fontWeight: fontWeight.regular, letterSpacing: letterSpacing.normal },
  bodySm: { fontSize: fontSize.sm, lineHeight: lineHeight.normal, fontWeight: fontWeight.regular, letterSpacing: letterSpacing.normal },
  label: { fontSize: fontSize.base, lineHeight: lineHeight.snug, fontWeight: fontWeight.medium, letterSpacing: letterSpacing.normal },
  caption: { fontSize: fontSize.xs, lineHeight: lineHeight.snug, fontWeight: fontWeight.regular, letterSpacing: letterSpacing.normal },
  overline: { fontSize: fontSize.xs, lineHeight: lineHeight.snug, fontWeight: fontWeight.semibold, letterSpacing: letterSpacing.wide },
} as const;

export const typography = { fontFamily, fontWeight, fontSize, lineHeight, letterSpacing, textStyle } as const;
