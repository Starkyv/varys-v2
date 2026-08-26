import type { RepairJobStatus, RepairJobSummary } from "@varys/review-contract";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  InfoTip,
  type InfoTipBlock,
  SegmentedControl,
  Skeleton,
  Sparkles,
} from "@varys/ui";
import { useState } from "react";
import { LiveIndicator } from "../../components/LiveIndicator";
import { useConfirm } from "../../context/confirm";
import { useRouter } from "../../context/router";
import { useToast } from "../../context/toast";
import { relativeTime } from "../../lib/format";
import { useCancelRepairJob, useRepairJobs } from "../../queries";
import styles from "./styles.module.scss";

/**
 * What each status means. The distinction this view exists for is the first two rows:
 * **unclaimed** is not "slow" — it means nothing is draining the queue at all, which is the
 * expected state for a project with no repair agent (Varys never starts a Claude itself,
 * ADR-0003). Saying so plainly is the difference between an accepted consequence and a mystery.
 */
const STATUS_LEGEND: InfoTipBlock[] = [
  { type: "heading", text: "What each status means" },
  {
    type: "table",
    head: ["Status", "Meaning"],
    rows: [
      ["Unclaimed", "Waiting. No repair agent has picked it up — if these pile up, nothing is draining the queue."],
      ["In progress", "A repair agent has claimed it and is working on it now. A claim expires — if the agent stops reporting, the job comes back here."],
      ["Repaired", "The agent proposed a fix. It lands as an unreviewed version — never a silent pass."],
      ["Failed", "Given up on: every attempt was spent without a repair. The test is still broken and still yours to fix."],
      ["Cancelled", "Someone decided to fix this by hand."],
    ],
  },
];

const STATUS_LABEL: Record<RepairJobStatus, string> = {
  queued: "Unclaimed",
  claimed: "In progress",
  done: "Repaired",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Unclaimed reads neutral, not alarming — a queue with no drainer is a configuration
 *  fact, not a failure. In-progress is the only "something is happening" tone. */
function StatusChip({ status }: { status: RepairJobStatus }) {
  const tone =
    status === "claimed"
      ? "info"
      : status === "done"
        ? "success"
        : status === "failed"
          ? "danger"
          : "neutral";
  return (
    <Badge tone={tone} appearance="soft" size="sm">
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

/**
 * What is left of a claim. A claim is a lease, so an in-progress job carries a deadline rather
 * than an open-ended "someone is on it" — and one that has run out is about to be back in the
 * queue, which is worth saying plainly instead of showing a stale claimer.
 */
function claimRemaining(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "claim expired — returning to the queue";
  return `claim expires in ${Math.max(1, Math.round(ms / 60_000))}m`;
}

type Scope = "open" | "all";

export function RepairQueue() {
  const [scope, setScope] = useState<Scope>("open");
  const jobs = useRepairJobs({ all: scope === "all" });
  const cancel = useCancelRepairJob();
  const { navigate } = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();

  async function onCancel(job: RepairJobSummary) {
    const ok = await confirm({
      title: "Cancel this repair?",
      message: `“${job.testName}” will stay broken until you fix it yourself. Nothing about the test changes.`,
      confirmLabel: "Cancel repair",
    });
    if (!ok) return;
    cancel.mutate(job.id, {
      onSuccess: () => toast("Repair cancelled"),
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t cancel the job"),
    });
  }

  if (jobs.isLoading) {
    return (
      <div className={styles.loading}>
        {[40, 52, 52, 52].map((h, i) => (
          <Skeleton key={i} height={h} radius="var(--radius-md)" />
        ))}
      </div>
    );
  }

  if (jobs.isError) {
    return (
      <ErrorState
        title="Repair queue unavailable"
        description="Polling GET /repair-jobs failed. It will keep retrying automatically."
        onRetry={() => jobs.refetch()}
        retryLabel="Retry now"
      />
    );
  }

  const data = jobs.data ?? [];
  if (data.length === 0) {
    return (
      <div>
        <div className={styles.scopeBar}>
          <SegmentedControl<Scope>
            ariaLabel="Which jobs to show"
            size="sm"
            options={[
              { value: "open", label: "Outstanding" },
              { value: "all", label: "All" },
            ]}
            value={scope}
            onValueChange={setScope}
          />
        </div>
        <EmptyState
          icon={<Sparkles />}
          tone="neutral"
          title={scope === "open" ? "Nothing waiting to be repaired" : "No repair jobs yet"}
          description="A test whose repair policy is Auto queues a job here when a run can no longer find an element. Set the policy on a test, or in bulk from the Tests list."
        />
      </div>
    );
  }

  const unclaimed = data.filter((j) => j.status === "queued").length;

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <h3 className={styles.title}>Repair queue</h3>
        <span className={styles.count}>
          {data.length} job{data.length === 1 ? "" : "s"}
          {unclaimed > 0 && ` · ${unclaimed} unclaimed`}
        </span>
        <SegmentedControl<Scope>
          ariaLabel="Which jobs to show"
          options={[
            { value: "open", label: "Outstanding" },
            { value: "all", label: "All" },
          ]}
          value={scope}
          onValueChange={setScope}
        />
        <span className={styles.spacer} />
        <LiveIndicator label="Live · polling every 5s" />
      </header>

      {unclaimed > 0 && (
        <div className={styles.notice}>
          {unclaimed} job{unclaimed === 1 ? " is" : "s are"} waiting for a repair agent to claim
          {unclaimed === 1 ? " it" : " them"}. Varys never starts an agent itself — a queue that
          only grows means nothing is draining it.
        </div>
      )}

      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.thLeft}>Test</th>
              <th>Broken locator</th>
              <th>
                <span className={styles.statusHead}>
                  Status
                  <InfoTip
                    label="What each repair status means"
                    placement="bottom"
                    portal
                    width={560}
                    blocks={STATUS_LEGEND}
                  />
                </span>
              </th>
              <th>Attempts</th>
              <th className={styles.thRight}>Queued</th>
              <th className={styles.thAction} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((j) => (
              <tr key={j.id} className={styles.row}>
                <td className={styles.tdTest}>
                  <button
                    type="button"
                    className={styles.testLink}
                    onClick={() => navigate({ name: "testDetail", testId: j.testId })}
                  >
                    {j.testName}
                  </button>
                  {j.runId && (
                    <button
                      type="button"
                      className={styles.runLink}
                      onClick={() => navigate({ name: "runDetail", runId: j.runId as string })}
                    >
                      the run that broke
                    </button>
                  )}
                </td>
                <td>
                  <code className={styles.cluster} title={j.clusterKey}>
                    {j.clusterKey}
                  </code>
                </td>
                <td>
                  <StatusChip status={j.status} />
                  {j.claimedBy && (
                    <div className={styles.claimer}>
                      {j.claimedBy}
                      {j.claimedAt ? ` · ${relativeTime(j.claimedAt)}` : ""}
                      {j.claimExpiresAt ? ` · ${claimRemaining(j.claimExpiresAt)}` : ""}
                    </div>
                  )}
                </td>
                <td className={styles.attempts}>{j.attempts}</td>
                <td className={styles.when}>{relativeTime(j.createdAt)}</td>
                <td className={styles.tdAction}>
                  {j.status === "queued" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={cancel.isPending}
                      onClick={() => void onCancel(j)}
                    >
                      Cancel
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
