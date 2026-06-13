/**
 * Shadow tokens — soft, low-contrast elevation matching the dashboard cards.
 * `focus` is the brand focus ring used on interactive controls.
 */
export const shadow = {
  none: "none",
  xs: "0 1px 2px rgba(16, 24, 40, 0.04)",
  sm: "0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06)",
  md: "0 2px 4px rgba(16, 24, 40, 0.05), 0 4px 12px rgba(16, 24, 40, 0.07)",
  lg: "0 8px 24px rgba(16, 24, 40, 0.10)",
  focus: "0 0 0 3px rgba(83, 71, 206, 0.32)",
} as const;

export type ShadowToken = keyof typeof shadow;
