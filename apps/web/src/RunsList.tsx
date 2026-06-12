import type { RunSummary } from "@varys/review-contract";
import { useRuns } from "./queries";
import styles from "./RunsList.module.css";

/** Status → display label + CSS modifier class. */
const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "queued" },
  running: { label: "Running", cls: "running" },
  passed: { label: "Passed", cls: "passed" },
  needs_review: { label: "Needs review", cls: "needsReview" },
  failed: { label: "Failed", cls: "failed" },
};

/**
 * The Runs history: every run, newest first, regardless of outcome — the place to
 * find a passed or failed run that never enters the (checkpoint-centric) Needs review
 * queue. Each row links into the viewer. Polls so a freshly-triggered run's status
 * advances (queued → running → terminal) without a manual refresh.
 */
export function RunsList() {
  const { data, isLoading, isError, error } = useRuns();

  if (isLoading) {
    return (
      <p role="status" className={styles.notice}>
        Loading runs…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className={styles.error}>
        Couldn’t load runs: {(error as Error).message}
      </p>
    );
  }
  if (!data) return null;
  if (data.length === 0) {
    return <p className={styles.empty}>No runs yet — trigger one from the Tests view.</p>;
  }

  return (
    <main className={styles.list}>
      <h1>Runs</h1>
      <ul className={styles.items}>
        {data.map((run) => (
          <li key={run.runId}>
            <RunRow run={run} />
          </li>
        ))}
      </ul>
    </main>
  );
}

function RunRow({ run }: { run: RunSummary }) {
  const status = STATUS[run.status] ?? { label: run.status, cls: "queued" };
  return (
    <a className={styles.row} href={`?run=${run.runId}`}>
      <span className={`${styles.status} ${styles[status.cls]}`}>{status.label}</span>
      <span className={styles.test}>{run.testName}</span>
      <span className={styles.env}>{run.environment}</span>
      <span className={styles.time}>{new Date(run.runTimestamp).toLocaleString()}</span>
      {run.status === "failed" && run.error && (
        <span className={styles.errorLine} title={run.error}>
          {run.error}
        </span>
      )}
    </a>
  );
}
