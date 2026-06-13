import type { ReactNode } from "react";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Hide the text label, keep it only as the accessible title (icon-only). */
  iconOnly?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
  className?: string;
}

/**
 * SegmentedControl — a pill group where one option is active (the diff viewer's
 * view-mode switch). The active segment lifts onto a white surface with a soft
 * shadow.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  size = "md",
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cx(styles.group, styles[size], className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={opt.label}
            onClick={() => onValueChange(opt.value)}
            className={cx(styles.segment, active && styles.active)}
          >
            {opt.icon && <span className={styles.icon}>{opt.icon}</span>}
            {!opt.iconOnly && <span>{opt.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
