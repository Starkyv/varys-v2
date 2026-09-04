import {
  EmptyState,
  ErrorState,
  IconButton,
  InfoTip,
  type InfoTipBlock,
  ListRun,
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
import { duration, formatActor, relativeTime } from "../../lib/format";
import { StatusBadge } from "../../lib/status";
import { useDeleteSuiteRun, useSuiteRuns } from "../../queries";
import { CountsBar } from "./components/CountsBar";
import styles from "./styles.module.scss";

/** What each value in the Status column means — the aggregate is DERIVED from the children,
 *  which is the part people get wrong, so the legend says so. */
const STATUS_LEGEND: InfoTipBlock[] = [
  { type: "heading", text: "What each status means" },
  {
    type: "table",
    head: ["Status", "Meaning"],
    rows: [
      [<StatusBadge key="q" status="queued" />, "Every child is still waiting for a worker."],
      [<StatusBadge key="r" status="running" />, "At least one child is queued or replaying."],
      [<StatusBadge key="f" status="failed" />, "Every child finished and at least one failed."],
      [
        <StatusBadge key="nr" status="needs_review" />,
        "Nothing failed, but a child is waiting on a human decision.",
      ],
      [<StatusBadge key="p" status="passed" />, "Every child finished green."],
    ],
  },
  {
    type: "para",
    text: "The aggregate is derived from the children on every read — approving a checkpoint moves the suite immediately. A healed child counts as passed: it verified, just on a repair nobody has accepted yet.",
  },
];

/** The scheduler launches a fan-out under the `schedule` sentinel; everything else is a person. */
type Trigger = "all" | "manual" | "schedule";
const TRIGGER_OPTIONS: SegmentedOption<Trigger>[] = [
  { value: "all", label: "All" },
  { value: "manual", label: "Manual" },
  { value: "schedule", label: "Scheduled" },
];
const TRIGGER_LABEL: Record<Trigger, string> = {
  all: "All",
  manual: "Manual",
  schedule: "Scheduled",
};

export function SuiteRuns() {
  const suiteRuns = useSuiteRuns();
  const { navigate } = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const del = useDeleteSuiteRun();
  const [trigger, setTrigger] = useState<Trigger>("all");

  async function onDelete(suiteRunId: string, suiteName: string, total: number, inFlight: boolean) {
    const ok = await confirm({
      title: inFlight ? "Cancel & delete suite run?" : "Delete suite run?",
      message: inFlight
        ? `“${suiteName}” is still running. This stops its ${total} child run${total === 1 ? "" : "s"} and deletes them along with the report (baselines are kept). This can’t be undone.`
        : `This deletes the “${suiteName}” fan-out and all ${total} of its child run${total === 1 ? "" : "s"} — their screenshots and history are removed (baselines are kept). This can’t be undone.`,
      confirmLabel: inFlight ? "Cancel & delete" : "Delete suite run",
      tone: "danger",
    });
    if (!ok) return;
    del.mutate(suiteRunId, {
      onSuccess: () => toast(inFlight ? "Suite run cancelled & deleted" : "Suite run deleted"),
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t delete suite run"),
    });
  }

  if (suiteRuns.isLoading) {
    return (
      <div className={styles.loading}>
        {[40, 52, 52, 52, 52].map((h, i) => (
          <Skeleton key={i} height={h} radius="var(--radius-md)" />
        ))}
      </div>
    );
  }

  if (suiteRuns.isError) {
    return (
      <ErrorState
        title="Suite-run history unavailable"
        description="Polling GET /suite-runs failed. It will keep retrying automatically."
        onRetry={() => suiteRuns.refetch()}
        retryLabel="Retry now"
      />
    );
  }

  const data = suiteRuns.data ?? [];
  if (data.length === 0) {
    return (
      <EmptyState
        icon={<ListRun />}
        tone="neutral"
        title="No suite runs yet"
        description="Run a suite across one or more environments to see the aggregated report here."
      />
    );
  }

  const filtered =
    trigger === "all"
      ? data
      : data.filter((r) => (r.triggeredBy === "schedule") === (trigger === "schedule"));

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <h3 className={styles.title}>
          {trigger === "all" ? "All suite runs" : `${TRIGGER_LABEL[trigger]} suite runs`}
        </h3>
        <span className={styles.count}>{filtered.length} fan-outs</span>
        <SegmentedControl
          ariaLabel="Filter suite runs by how they were triggered"
          options={TRIGGER_OPTIONS}
          value={trigger}
          onValueChange={setTrigger}
        />
        <span className={styles.spacer} />
        <LiveIndicator label="Live · polling every 3s" />
      </header>
      {filtered.length === 0 ? (
        <div className={styles.filterEmpty}>
          No {TRIGGER_LABEL[trigger].toLowerCase()} suite runs yet
          {trigger === "schedule" && " — set a cron schedule on a suite and it'll appear here when it fires."}
        </div>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thLeft}>Suite</th>
                <th>Environments</th>
                <th>Results</th>
                <th>
                  <span className={styles.statusHead}>
                    Status
                    <InfoTip
                      label="What each suite-run status means"
                      placement="bottom"
                      portal
                      width={560}
                      blocks={STATUS_LEGEND}
                    />
                  </span>
                </th>
                <th>Duration</th>
                <th>Triggered by</th>
                <th className={styles.thRight}>When</th>
                <th className={styles.thAction} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const inFlight = r.status === "queued" || r.status === "running";
                const open = () => navigate({ name: "suiteRunDetail", suiteRunId: r.suiteRunId });
                return (
                  <tr
                    key={r.suiteRunId}
                    tabIndex={0}
                    className={styles.row}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") open();
                    }}
                  >
                    <td className={styles.tdSuite}>
                      <div className={styles.suiteName}>{r.suiteName}</div>
                      <div className={styles.shape}>
                        {r.testCount} test{r.testCount === 1 ? "" : "s"} ×{" "}
                        {r.environments.length} env{r.environments.length === 1 ? "" : "s"}
                      </div>
                    </td>
                    <td className={styles.envs} title={r.environments.join(", ")}>
                      {r.environments.join(" · ")}
                      {/* A deleted environment still has children in the report, so say it here
                          rather than letting the fan-out look narrower than it was. */}
                      {r.environmentsMissing > 0 && (
                        <span className={styles.missing}> · {r.environmentsMissing} deleted</span>
                      )}
                    </td>
                    <td>
                      <CountsBar counts={r.counts} />
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className={styles.numeric}>
                      {r.durationMs != null ? duration(r.durationMs) : "—"}
                    </td>
                    <td className={styles.actor} title={r.triggeredBy ?? undefined}>
                      {r.triggeredBy === "schedule" ? "Schedule" : formatActor(r.triggeredBy) || "—"}
                    </td>
                    <td className={styles.when}>{relativeTime(r.runTimestamp)}</td>
                    <td className={styles.tdAction}>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        icon={<Trash size={15} />}
                        label={inFlight ? "Cancel & delete suite run" : "Delete suite run"}
                        className={styles.deleteBtn}
                        disabled={del.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onDelete(r.suiteRunId, r.suiteName, r.counts.total, inFlight);
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
