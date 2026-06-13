import { Activity, EmptyState, ErrorState, Skeleton } from "@varys/ui";
import { LiveIndicator } from "../../components/LiveIndicator";
import { useRouter } from "../../context/router";
import { relativeTime } from "../../lib/format";
import { StatusBadge } from "../../lib/status";
import { useRuns } from "../../queries";
import styles from "./styles.module.scss";

export function Runs() {
  const runs = useRuns();
  const { navigate } = useRouter();

  if (runs.isLoading) {
    return (
      <div className={styles.loading}>
        {[40, 52, 52, 52, 52].map((h, i) => (
          <Skeleton key={i} height={h} radius="var(--radius-md)" />
        ))}
      </div>
    );
  }

  if (runs.isError) {
    return (
      <ErrorState
        title="Run history unavailable"
        description="Polling GET /runs failed. It will keep retrying automatically."
        onRetry={() => runs.refetch()}
        retryLabel="Retry now"
      />
    );
  }

  const data = runs.data ?? [];
  if (data.length === 0) {
    return (
      <EmptyState
        icon={<Activity />}
        tone="neutral"
        title="No runs yet"
        description="Trigger a test to see its replay appear here, newest first, with live status."
      />
    );
  }

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <h3 className={styles.title}>All runs</h3>
        <span className={styles.count}>{data.length} runs</span>
        <span className={styles.spacer} />
        <LiveIndicator label="Live · polling every 3s" />
      </header>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.thLeft}>Test</th>
              <th>Environment</th>
              <th>Status</th>
              <th className={styles.thRight}>When</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr
                key={r.runId}
                tabIndex={0}
                className={styles.row}
                onClick={() => navigate({ name: "runDetail", runId: r.runId })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") navigate({ name: "runDetail", runId: r.runId });
                }}
              >
                <td className={styles.tdTest}>
                  <div className={styles.testName}>{r.testName}</div>
                  {r.error && <div className={styles.error}>{r.error}</div>}
                </td>
                <td className={styles.env}>{r.environment}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className={styles.when}>{relativeTime(r.runTimestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
