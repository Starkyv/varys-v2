import { cx } from "../../utils/cx";
import styles from "./Badge.module.scss";
import type { BadgeProps } from "./Badge.types";

/**
 * Badge — compact status / metadata pill. Soft by default (the dashboard's
 * `15.8% ↗` delta badges); also solid and outline. Tones map to status tokens,
 * so the same component renders Varys run statuses (passed / diff / error).
 *
 *   <Badge tone="success" icon={<ArrowUpRight />}>15.8%</Badge>
 *   <Badge tone="warning" dot>Needs review</Badge>
 */
export function Badge({
  tone = "neutral",
  appearance = "soft",
  size = "sm",
  dot = false,
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cx(styles.badge, styles[tone], styles[appearance], styles[size], className)}
      {...rest}
    >
      {dot && <span className={styles.dot} aria-hidden />}
      {icon && <span className={styles.icon}>{icon}</span>}
      {children}
    </span>
  );
}
