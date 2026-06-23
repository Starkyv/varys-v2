import type { RunSummary } from "@varys/review-contract";
import { Activity, Button, Skeleton } from "@varys/ui";
import { useRouter } from "../../../../context/router";
import { relativeTime } from "../../../../lib/format";
import { StatusBadge, statusVars } from "../../../../lib/status";
import styles from "./styles.module.scss";

const SKELETON_ROWS = ["a", "b", "c", "d", "e"];

export function RecentRuns({
  runs,
  loading,
  error,
  onRetry,
}: {
  runs: RunSummary[];
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const { navigate } = useRouter();
  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <Activity size={18} />
        </span>
        <h3 className={styles.title}>Recent runs</h3>
        <Button variant="secondary" size="sm" onClick={() => navigate({ name: "runs" })}>
          View all
        </Button>
      </header>

      {loading ? (
        <div className={styles.list}>
          {SKELETON_ROWS.map((id) => (
            <div key={id} className={styles.skeletonRow}>
              <Skeleton circle width={8} height={8} />
              <Skeleton height={14} width="55%" radius="var(--radius-sm)" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className={styles.state}>
          Couldn’t load recent runs.{" "}
          {onRetry && (
            <button type="button" className={styles.retry} onClick={() => onRetry()}>
              Retry
            </button>
          )}
        </div>
      ) : runs.length === 0 ? (
        <div className={styles.state}>No runs yet — record a test and run it to see activity here.</div>
      ) : (
        <div className={styles.list}>
          {runs.map((r) => (
            <button
              key={r.runId}
              type="button"
              className={styles.row}
              onClick={() => navigate({ name: "runDetail", runId: r.runId })}
            >
              <span className={styles.dot} style={{ background: statusVars(r.outcome).base }} />
              <span className={styles.text}>
                <span className={styles.name}>{r.testName}</span>
                <span className={styles.meta}>
                  {r.environment} · {relativeTime(r.runTimestamp)}
                </span>
              </span>
              <StatusBadge status={r.outcome} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
