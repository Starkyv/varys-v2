/**
 * Border-radius tokens — read off the dashboard: inputs/buttons ~8px, cards ~16px,
 * pills/badges fully rounded, small chips ~6px.
 */
export const radius = {
  none: "0",
  sm: "6px", // chips, small controls
  md: "8px", // buttons, inputs, dropdowns
  lg: "12px", // panels
  xl: "16px", // cards
  "2xl": "20px",
  full: "9999px", // pills, avatars, toggles
} as const;

export type RadiusToken = keyof typeof radius;
