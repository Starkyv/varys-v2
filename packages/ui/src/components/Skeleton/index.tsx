import type { CSSProperties, HTMLAttributes } from "react";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  width?: number | string;
  height?: number | string;
  /** Border radius token value (defaults to `--radius-sm`). */
  radius?: string;
  /** Render as a circle (avatars, status dots). */
  circle?: boolean;
}

/**
 * Skeleton — a shimmering placeholder block for loading states. The shimmer is
 * CSS-only and pauses under `prefers-reduced-motion`.
 */
export function Skeleton({ width, height, radius, circle, className, style, ...rest }: SkeletonProps) {
  const css: CSSProperties = {
    width,
    height,
    borderRadius: circle ? "var(--radius-full)" : radius,
    ...style,
  };
  return <div aria-hidden className={cx(styles.skeleton, className)} style={css} {...rest} />;
}
