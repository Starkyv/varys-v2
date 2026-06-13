/**
 * z-index tokens — a single ordered scale so stacking is intentional, never ad-hoc.
 */
export const zIndex = {
  hide: -1,
  base: 0,
  raised: 1,
  dropdown: 1000,
  sticky: 1100,
  overlay: 1200,
  modal: 1300,
  popover: 1400,
  toast: 1500,
  tooltip: 1600,
} as const;

export type ZIndexToken = keyof typeof zIndex;
