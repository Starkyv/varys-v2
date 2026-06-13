/**
 * Spacing tokens — a 4px base grid with 2px half-steps. Keyed by pixel value so
 * the name is the size (`space[8]` === 8px === `var(--space-8)`). Values are rem
 * (root = 16px).
 */
export const space = {
  0: "0",
  2: "0.125rem", // 2px
  4: "0.25rem", // 4px
  6: "0.375rem", // 6px
  8: "0.5rem", // 8px
  10: "0.625rem", // 10px
  12: "0.75rem", // 12px
  16: "1rem", // 16px
  20: "1.25rem", // 20px
  24: "1.5rem", // 24px
  32: "2rem", // 32px
  40: "2.5rem", // 40px
  48: "3rem", // 48px
  64: "4rem", // 64px
} as const;

export type SpaceToken = keyof typeof space;
