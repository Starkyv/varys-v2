import { AlertTriangle } from "../../icons";
import { Button } from "../Button";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

export interface ErrorStateProps {
  title: string;
  description?: string;
  /** When provided, renders a Retry button. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

/**
 * ErrorState — the full-card read-failure surface (a 5xx, a dropped poll). A
 * danger medallion over a title, an optional explanation and a Retry action.
 */
export function ErrorState({ title, description, onRetry, retryLabel = "Retry", className }: ErrorStateProps) {
  return (
    <div className={cx(styles.error, className)}>
      <span className={styles.medallion}>
        <AlertTriangle />
      </span>
      <div className={styles.title}>{title}</div>
      {description && <div className={styles.description}>{description}</div>}
      {onRetry && (
        <Button variant="primary" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
