import type { RunSummary, SuiteRunSummary } from "@varys/review-contract";
import { useRuns, useSuiteRuns } from "./queries";
import styles from "./RunsList.module.css";

/** Status → display label + CSS modifier class (run-level and suite-aggregate
 *  statuses share one taxonomy). */
const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "queued" },
  running: { label: "Running", cls: "running" },
  passed: { label: "Passed", cls: "passed" },
  needs_review: { label: "Needs review", cls: "needsReview" },
  failed: { label: "Failed", cls: "failed" },
};

/** One history entry: a standalone run, or a suite run as a single aggregate
 *  row (its children live in the report, not here). */
type HistoryEntry =
  | { kind: "run"; at: string; run: RunSummary }
  | { kind: "suiteRun"; at: string; suiteRun: SuiteRunSummary };

/**
 * The Runs history: standalone runs and suite-run aggregates interleaved by
 * recency, newest first — the place to find any outcome (incl. passed/failed
 * runs that never enter the checkpoint-centric Needs review queue). A suite's
 * fan-out appears as ONE row here; its children are reachable only through the
 * `?suiteRun=` report. Polls so statuses advance without a manual refresh.
 */
export function RunsList() {
  const runs = useRuns();
  const suiteRuns = useSuiteRuns();

  if (runs.isLoading || suiteRuns.isLoading) {
    return (
      <p role="status" className={styles.notice}>
        Loading runs…
      </p>
    );
  }
  if (runs.isError || suiteRuns.isError) {
    const err = (runs.error ?? suiteRuns.error) as Error;
    return (
      <p role="alert" className={styles.error}>
        Couldn’t load runs: {err.message}
      </p>
    );
  }

  const entries: HistoryEntry[] = [
    ...(runs.data ?? []).map(
      (run): HistoryEntry => ({ kind: "run", at: run.runTimestamp, run }),
    ),
    ...(suiteRuns.data ?? []).map(
      (suiteRun): HistoryEntry => ({ kind: "suiteRun", at: suiteRun.runTimestamp, suiteRun }),
    ),
  ].sort((a, b) => b.at.localeCompare(a.at));

  if (entries.length === 0) {
    return (
      <p className={styles.empty}>
        No runs yet — trigger one from the Tests view, or run a suite from the Suites view.
      </p>
    );
  }

  return (
    <main className={styles.list}>
      <h1>Runs</h1>
      <ul className={styles.items}>
        {entries.map((e) =>
          e.kind === "run" ? (
            <li key={e.run.runId}>
              <RunRow run={e.run} />
            </li>
          ) : (
            <li key={e.suiteRun.suiteRunId}>
              <SuiteRunRow suiteRun={e.suiteRun} />
            </li>
          ),
        )}
      </ul>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, cls: "queued" };
  return <span className={`${styles.status} ${styles[s.cls]}`}>{s.label}</span>;
}

function RunRow({ run }: { run: RunSummary }) {
  return (
    <a className={styles.row} href={`?run=${run.runId}`}>
      <StatusBadge status={run.status} />
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

/** A whole fan-out as one row: derived aggregate status + counts; opens the
 *  per-(test × env) report. */
function SuiteRunRow({ suiteRun }: { suiteRun: SuiteRunSummary }) {
  const { counts } = suiteRun;
  const inFlight = counts.queued + counts.running;
  const parts = [
    counts.passed > 0 ? `${counts.passed} passed` : null,
    counts.needsReview > 0 ? `${counts.needsReview} needs review` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    inFlight > 0 ? `${inFlight} in flight` : null,
  ].filter(Boolean);

  return (
    <a className={styles.row} href={`?suiteRun=${suiteRun.suiteRunId}`}>
      <StatusBadge status={suiteRun.status} />
      <span className={styles.test}>
        {suiteRun.suiteName} <span className={styles.suiteTag}>suite</span>
      </span>
      <span className={styles.counts}>
        {counts.total} run{counts.total === 1 ? "" : "s"}
        {parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}
      </span>
      <span className={styles.env}>{suiteRun.environments.join(", ")}</span>
      <span className={styles.time}>{new Date(suiteRun.runTimestamp).toLocaleString()}</span>
    </a>
  );
}
