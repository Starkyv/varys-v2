import type { HTMLAttributes } from "react";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  /** Pixel size (width = height). Defaults to 1em so it scales with text. */
  size?: number | string;
  /** Accessible label announced to assistive tech. */
  label?: string;
}

/**
 * Spinner — an indeterminate loading arc. Inherits `currentColor` and sizes to the
 * font by default, so it drops into a button label, a status pill, or a table cell.
 */
export function Spinner({ size = "1em", label = "Loading", className, style, ...rest }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cx(styles.spinner, className)}
      style={{ width: size, height: size, ...style }}
      {...rest}
    >
      <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden>
        <path d="M21 12a9 9 0 1 1-6.2-8.5" />
      </svg>
    </span>
  );
}
