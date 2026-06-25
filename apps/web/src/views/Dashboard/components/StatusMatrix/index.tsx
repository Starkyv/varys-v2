import type { DashboardMatrix } from "@varys/review-contract";
import { Grid, Skeleton } from "@varys/ui";
import { motion, useReducedMotion } from "framer-motion";
import { useRouter } from "../../../../context/router";
import { StatusIcon, statusLabel, statusVars, TONE_VARS } from "../../../../lib/status";
import styles from "./styles.module.scss";

const LEGEND = [
  { label: "Passed", tone: "success" as const },
  { label: "Baseline", tone: "info" as const },
  { label: "Pending", tone: "warning" as const },
  { label: "Regression", tone: "danger" as const },
  { label: "Failed", tone: "danger" as const },
];

const SKELETON_ROWS = ["a", "b", "c", "d", "e"];

export function StatusMatrix({
  matrix,
  loading,
  error,
  onRetry,
}: {
  matrix?: DashboardMatrix;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const { navigate } = useRouter();
  const reduce = useReducedMotion();
  const environments = matrix?.environments ?? [];
  const rows = matrix?.rows ?? [];
  const cols = `minmax(120px, 1.6fr) repeat(${Math.max(environments.length, 1)}, minmax(0, 1fr))`;

  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <Grid size={18} />
        </span>
        <div className={styles.titleBlock}>
          <h3 className={styles.title}>Test × Environment status</h3>
          <div className={styles.subtitle}>Latest run per cell · click to open</div>
        </div>
        <div className={styles.legend}>
          {LEGEND.map((l) => (
            <span key={l.label} className={styles.legendItem}>
              <span className={styles.legendDot} style={{ background: TONE_VARS[l.tone].base }} />
              {l.label}
            </span>
          ))}
        </div>
      </header>

      {loading ? (
        <div className={styles.skeletonStack}>
          {SKELETON_ROWS.map((id) => (
            <Skeleton key={id} height={40} radius="var(--radius-md)" />
          ))}
        </div>
      ) : error ? (
        <div className={styles.state}>
          Couldn’t load the status matrix.{" "}
          {onRetry && (
            <button type="button" className={styles.retry} onClick={() => onRetry()}>
              Retry
            </button>
          )}
        </div>
      ) : rows.length === 0 ? (
        <div className={styles.state}>No runs yet — run a test to populate the matrix.</div>
      ) : (
        <div className={styles.scroll}>
          <div className={styles.grid}>
            <div className={styles.headRow} style={{ gridTemplateColumns: cols }}>
              <div className={styles.headTest}>Test</div>
              {environments.map((env) => (
                <div key={env} className={styles.headEnv}>
                  {env}
                </div>
              ))}
            </div>

            {rows.map((row) => (
              <div key={row.testId} className={styles.row} style={{ gridTemplateColumns: cols }}>
                <div className={styles.rowName}>{row.testName}</div>
                {row.cells.map((cell) => {
                  const none = cell.status === "none";
                  const vars = statusVars(cell.status);
                  return (
                    <div key={cell.environment} className={styles.cellWrap}>
                      <motion.button
                        type="button"
                        disabled={none}
                        whileHover={none || reduce ? undefined : { scale: 1.14 }}
                        transition={{ type: "spring", stiffness: 600, damping: 24 }}
                        title={`${row.testName} · ${cell.environment} · ${statusLabel(cell.status)}`}
                        className={styles.cell}
                        style={
                          none
                            ? {
                                background: "var(--color-bg-subtle)",
                                color: "var(--color-text-subtle)",
                                borderColor: "var(--color-border)",
                              }
                            : { background: vars.soft, color: vars.fg, borderColor: "transparent" }
                        }
                        onClick={() => cell.runId && navigate({ name: "runDetail", runId: cell.runId })}
                      >
                        <StatusIcon status={cell.status} size={14} />
                      </motion.button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
