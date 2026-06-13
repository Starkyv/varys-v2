/**
 * Breakpoint tokens — min-width in px. Consume via the `mq` SCSS mixin
 * (`foundations/mixins.scss`) or `useMediaQuery` (`hooks/`).
 */
export const breakpoint = {
  xs: 480,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

export type BreakpointToken = keyof typeof breakpoint;
