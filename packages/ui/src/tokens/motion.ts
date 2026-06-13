/**
 * Motion tokens — durations + easing curves for transitions and micro-interactions.
 */
export const duration = {
  fast: "120ms", // hovers, toggles
  base: "200ms", // most transitions
  slow: "320ms", // overlays, expanding panels
} as const;

export const easing = {
  standard: "cubic-bezier(0.4, 0, 0.2, 1)", // default
  accelerate: "cubic-bezier(0.4, 0, 1, 1)", // exit
  decelerate: "cubic-bezier(0, 0, 0.2, 1)", // enter
  emphasized: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

export const motion = { duration, easing } as const;

export type DurationToken = keyof typeof duration;
export type EasingToken = keyof typeof easing;
