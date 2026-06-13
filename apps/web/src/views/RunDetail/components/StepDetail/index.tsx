import { AlertTriangle, Button, cx, ExternalLink } from "@varys/ui";
import type { ReactNode } from "react";
import { absoluteTime, duration } from "../../../../lib/format";
import styles from "./styles.module.scss";

type Outcome = "passed" | "failed" | "never";

const OUTCOME_LABEL: Record<Outcome, string> = {
  passed: "Passed",
  failed: "Failed",
  never: "Didn’t run",
};

/**
 * The right-pane surface when a non-checkpoint step is selected. A compact
 * "Step detail" card; for the failing step it surfaces the full error and the
 * Open-Playwright-trace affordance.
 */
export function StepDetail({
  icon,
  label,
  outcome,
  startedAt,
  durationMs,
  error,
  traceUrl,
  onOpenTrace,
}: {
  icon: ReactNode;
  label: string;
  outcome: Outcome;
  startedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  traceUrl?: string | null;
  onOpenTrace?: () => void;
}) {
  const failing = outcome === "failed";
  const never = outcome === "never";

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <span className={styles.glyph}>{icon}</span>
        <span className={styles.title}>Step detail</span>
        <span className={styles.spacer} />
        <span className={cx(styles.outcome, styles[`outcome_${outcome}`])}>{OUTCOME_LABEL[outcome]}</span>
      </header>

      <div className={styles.body}>
        <div className={styles.label}>{label}</div>

        {never ? (
          <p className={styles.neverNote}>This step never ran — the run failed before reaching it.</p>
        ) : (
          <div className={styles.meta}>
            <div className={styles.metaItem}>
              <span className={styles.metaKey}>Started</span>
              <span className={styles.metaValue}>{startedAt ? absoluteTime(startedAt) : "—"}</span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaKey}>Duration</span>
              <span className={styles.metaValue}>{durationMs != null ? duration(durationMs) : "—"}</span>
            </div>
          </div>
        )}

        {failing && (
          <>
            <div className={styles.errorCard}>
              <span className={styles.errorIcon}>
                <AlertTriangle size={20} />
              </span>
              <div className={styles.errorText}>
                <div className={styles.errorTitle}>This step failed the run</div>
                <div className={styles.errorMessage}>{error ?? "No error message was recorded."}</div>
              </div>
            </div>
            {traceUrl && (
              <div>
                <Button variant="secondary" iconLeft={<ExternalLink size={15} />} onClick={onOpenTrace}>
                  Open Playwright trace
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
