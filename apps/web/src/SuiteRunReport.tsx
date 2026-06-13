import type { SuiteRunChild, SuiteRunCounts } from "@varys/review-contract";
import { useSuiteRun } from "./queries";
import styles from "./SuiteRunReport.module.css";

/** Status → display label + CSS modifier class (same taxonomy as RunsList). */
const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "queued" },
  running: { label: "Running", cls: "running" },
  passed: { label: "Passed", cls: "passed" },
  needs_review: { label: "Needs review", cls: "needsReview" },
  failed: { label: "Failed", cls: "failed" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, cls: "queued" };
  return <span className={`${styles.status} ${styles[s.cls]}`}>{s.label}</span>;
}

/** The aggregate counts line, omitting zero buckets ("4 passed · 1 failed"). */
function countsLine(counts: SuiteRunCounts): string {
  const inFlight = counts.queued + counts.running;
  const parts = [
    counts.passed > 0 ? `${counts.passed} passed` : null,
    counts.needsReview > 0 ? `${counts.needsReview} needs review` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    inFlight > 0 ? `${inFlight} in flight` : null,
  ].filter(Boolean);
  return `${parts.join(" · ")} — ${counts.total} run${counts.total === 1 ? "" : "s"} total`;
}

/**
 * The suite-run report (deep link `?suiteRun=<id>`): the fan-out's aggregate
 * verdict plus a per-(test × environment) breakdown, each child opening in the
 * existing run view / diff viewer via `?run=`. Status and counts are derived
 * server-side from the live children — the view polls while any is in flight.
 */
export function SuiteRunReport({ suiteRunId }: { suiteRunId: string }) {
  const { data, isLoading, isError, error } = useSuiteRun(suiteRunId);

  if (isLoading) {
    return (
      <p role="status" className={styles.notice}>
        Loading suite run…
      </p>
    );
  }
  if (isError || !data) {
    return (
      <p role="alert" className={styles.error}>
        Couldn’t load this suite run{error ? `: ${(error as Error).message}` : ""}.
      </p>
    );
  }

  return (
    <main className={styles.report}>
      <nav className={styles.crumbs}>
        <a href="?view=suites">← Suites</a>
        <a href="?view=runs">Runs</a>
      </nav>
      <header className={styles.header}>
        <h1>{data.suiteName}</h1>
        <StatusBadge status={data.status} />
      </header>
      <p className={styles.meta}>
        {new Date(data.runTimestamp).toLocaleString()} · {data.environments.join(", ")}
      </p>
      <p className={styles.counts}>{countsLine(data.counts)}</p>

      <ul className={styles.items}>
        {data.children.map((child) => (
          <li key={child.runId}>
            <ChildRow child={child} />
          </li>
        ))}
      </ul>
    </main>
  );
}

function ChildRow({ child }: { child: SuiteRunChild }) {
  return (
    <a className={styles.row} href={`?run=${child.runId}`}>
      <StatusBadge status={child.status} />
      <span className={styles.test}>{child.testName}</span>
      <span className={styles.env}>{child.environment}</span>
      {child.status === "failed" && child.error && (
        <span className={styles.errorLine} title={child.error}>
          {child.error}
        </span>
      )}
    </a>
  );
}
