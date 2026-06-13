import type { ReactNode } from "react";
import type { Intent } from "../../types";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  /** Optional CTA row (a Button, link, or hint). */
  action?: ReactNode;
  /** Tints the icon medallion. Defaults to `primary`. */
  tone?: Extract<Intent, "primary" | "neutral" | "success">;
  className?: string;
}

/**
 * EmptyState — the full-card "nothing here yet" surface (no tests, empty review
 * queue, no suite runs). A tinted icon medallion over a title, description and an
 * optional action.
 */
export function EmptyState({ icon, title, description, action, tone = "primary", className }: EmptyStateProps) {
  return (
    <div className={cx(styles.empty, className)}>
      <span className={cx(styles.medallion, styles[tone])}>{icon}</span>
      <div className={styles.title}>{title}</div>
      {description && <div className={styles.description}>{description}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
