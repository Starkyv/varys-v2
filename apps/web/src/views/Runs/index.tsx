import {
  Activity,
  EmptyState,
  ErrorState,
  IconButton,
  InfoTip,
  type InfoTipBlock,
  SegmentedControl,
  type SegmentedOption,
  Skeleton,
  Trash,
} from "@varys/ui";
import { useState } from "react";
import { LiveIndicator } from "../../components/LiveIndicator";
import { useConfirm } from "../../context/confirm";
import { useRouter } from "../../context/router";
import { useToast } from "../../context/toast";
import { relativeTime } from "../../lib/format";
import { StatusBadge } from "../../lib/status";
import { useDeleteRun, useRuns } from "../../queries";
import styles from "./styles.module.scss";

/** What each value in the Status column means — the run-outcome taxonomy (RunOutcome),
 *  shown in a tooltip on the column header. */
const STATUS_LEGEND: InfoTipBlock[] = [
  { type: "heading", text: "What each status means" },
  {
    type: "table",
    head: ["Status", "Meaning"],
    // The first column is the real status chip, so the legend matches what's in the column.
    rows: [
      [<StatusBadge key="q" status="queued" />, "Waiting for a worker."],
      [<StatusBadge key="r" status="running" />, "Replaying in the browser right now."],
      [<StatusBadge key="p" status="passed" />, "Baseline matched — a real verification."],
      [<StatusBadge key="b" status="baseline" />, "Set or updated the golden baseline."],
      [<StatusBadge key="pb" status="pending-baseline" />, "First run, no baseline yet — awaiting approval."],
      [<StatusBadge key="reg" status="regression" />, "A baseline existed and the new capture differs — a visual change."],
      [<StatusBadge key="f" status="failed" />, "The test couldn’t run — an element wasn’t found, or the replay crashed."],
    ],
  },
];

/** How a run was triggered, for the source filter + column. Older runs may have null → "Manual". */
type RunSource = "all" | "manual" | "schedule" | "suite" | "api";
const SOURCE_OPTIONS: SegmentedOption<RunSource>[] = [
  { value: "all", label: "All" },
  { value: "manual", label: "Manual" },
  { value: "schedule", label: "Scheduled" },
  // { value: "suite", label: "Suite" },
];
const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual",
  schedule: "Scheduled",
  suite: "Suite",
  api: "API",
};
const sourceOf = (triggerSource: string | null): string => triggerSource ?? "manual";

export function Runs() {
  const runs = useRuns();
  const { navigate } = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const del = useDeleteRun();
  const [source, setSource] = useState<RunSource>("all");

  async function onDelete(runId: string, testName: string) {
    const ok = await confirm({
      title: "Delete run?",
      message: `This deletes the run of “${testName}” — its screenshots and history are removed (baselines are kept). This can’t be undone.`,
      confirmLabel: "Delete run",
      tone: "danger",
    });
    if (!ok) return;
    del.mutate(runId, {
      onSuccess: () => toast("Run deleted"),
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t delete run"),
    });
  }

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

  const filtered = source === "all" ? data : data.filter((r) => sourceOf(r.triggerSource) === source);

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <h3 className={styles.title}>{source === "all" ? "All runs" : `${SOURCE_LABEL[source]} runs`}</h3>
        <span className={styles.count}>{filtered.length} runs</span>
        <SegmentedControl
          ariaLabel="Filter runs by trigger source"
          options={SOURCE_OPTIONS}
          value={source}
          onValueChange={setSource}
        />
        <span className={styles.spacer} />
        <LiveIndicator label="Live · polling every 3s" />
      </header>
      {filtered.length === 0 ? (
        <div className={styles.filterEmpty}>
          No {SOURCE_LABEL[source]?.toLowerCase()} runs yet
          {source === "schedule" && " — set a cron schedule on a test and it'll appear here when it fires."}
        </div>
      ) : (
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.thLeft}>Test</th>
              <th>Environment</th>
              <th>Source</th>
              <th>
                <span className={styles.statusHead}>
                  Status
                  <InfoTip
                    label="What each run status means"
                    placement="bottom"
                    portal
                    width={560}
                    blocks={STATUS_LEGEND}
                  />
                </span>
              </th>
              <th className={styles.thRight}>When</th>
              <th className={styles.thAction} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const inFlight = r.status === "queued" || r.status === "running";
              return (
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
                  <td className={styles.env}>{SOURCE_LABEL[sourceOf(r.triggerSource)] ?? "Manual"}</td>
                  <td>
                    <StatusBadge status={r.outcome} />
                  </td>
                  <td className={styles.when}>{relativeTime(r.runTimestamp)}</td>
                  <td className={styles.tdAction}>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      icon={<Trash size={15} />}
                      label={inFlight ? "Can’t delete a run that’s still in progress" : "Delete run"}
                      className={styles.deleteBtn}
                      disabled={inFlight || del.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDelete(r.runId, r.testName);
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
