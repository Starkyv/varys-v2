import type { RepairJobStatus, RepairJobSummary, RepairReviewItem } from "@varys/review-contract";
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
import { StatusBadge } from "../../lib/status";
import {
  useCancelRepairJob,
  useDecideRepairReview,
  useRepairJobs,
  useRepairReviews,
} from "../../queries";
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

/**
 * Repaired versions waiting on a human (slice 04) — the gate that stops an unattended agent's
 * edit from silently becoming the definition every run replays. Accept keeps it (it is already the
 * test's latest version); reject reverts the test to what it said before.
 *
 * Deliberately terse: the side-by-side signal diff, the agent's justification against the brief,
 * and a clustered repair's blast radius are slice 13's job. What is here is enough to act on, so
 * the queue does not accumulate versions nobody can decide about.
 */
function RepairReviews() {
  const reviews = useRepairReviews();
  const decide = useDecideRepairReview();
  const { navigate } = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();

  const items = reviews.data ?? [];
  if (items.length === 0) return null;
  // How many of these have already been re-run and came back clean. It is the difference between
  // "N repairs to read" and "N repairs, and this many have already proved themselves" — which is
  // the whole reason the re-run exists.
  const healed = items.filter((i) => i.rerunOutcome === "healed").length;

  async function onDecide(item: RepairReviewItem, action: "accept" | "reject") {
    if (action === "reject") {
      const ok = await confirm({
        title: "Reject this repair?",
        message: `“${item.testName}” goes back to what v${item.previousVersion ?? "?"} said. The rejected version is kept in the test's history, and the test stays broken until you fix it.`,
        confirmLabel: "Reject and revert",
      });
      if (!ok) return;
    }
    decide.mutate(
      { versionId: item.versionId, action },
      {
        onSuccess: (res) => toast(res.note),
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t record the decision"),
      },
    );
  }

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <h3 className={styles.title}>Repaired versions awaiting review</h3>
        <span className={styles.count}>
          {items.length} version{items.length === 1 ? "" : "s"}
          {healed > 0 && ` · ${healed} healed`}
        </span>
      </header>
      <div className={styles.notice}>
        A repair agent wrote these, and each one argued its case against the test's Brief before it
        was allowed to stand. That gate is not your review: the failing run is still red, and
        accepting is what confirms the repaired version as the one your runs replay.
      </div>
      {items.map((item) => (
        <div key={item.versionId} className={styles.review}>
          <div className={styles.reviewMain}>
            <button
              type="button"
              className={styles.testLink}
              onClick={() => navigate({ name: "testDetail", testId: item.testId })}
            >
              {item.testName}
            </button>
            <div className={styles.reviewMeta}>
              v{item.version}
              {item.previousVersion !== null && ` · was v${item.previousVersion}`}
              {item.createdBy && ` · ${item.createdBy}`}
              {` · ${relativeTime(item.createdAt)}`}
              {!item.isActiveDefinition && " · a later edit has landed on top"}
            </div>
            {item.report && <p className={styles.report}>{item.report}</p>}
            {/* The justification and the Brief, together and in that order: the agent's claim is
                only checkable against the thing it was checked against, so showing a verdict
                without the Brief beside it would tell a reviewer nothing. */}
            {item.justification && (
              <p className={styles.justification}>
                <span className={styles.justificationLabel}>Justified as</span> {item.justification}
                {item.justificationReasoning && (
                  <span className={styles.verdict}>Judge: {item.justificationReasoning}</span>
                )}
              </p>
            )}
            {item.brief && <p className={styles.brief}>Brief: {item.brief}</p>}
            {item.runId && (
              <button
                type="button"
                className={styles.runLink}
                onClick={() => navigate({ name: "runDetail", runId: item.runId as string })}
              >
                the run that broke — still failed
              </button>
            )}
            {/* The re-run: the only evidence here that isn't the agent's own account of itself.
                `healed` means it was exercised and everything verified; anything else means the
                repair did not actually fix it, which is the more useful of the two answers. */}
            {item.rerunRunId && item.rerunOutcome && (
              <div className={styles.rerun}>
                <StatusBadge status={item.rerunOutcome} size="sm" />
                <button
                  type="button"
                  className={styles.runLink}
                  onClick={() => navigate({ name: "runDetail", runId: item.rerunRunId as string })}
                >
                  {item.rerunOutcome === "healed"
                    ? "the re-run against this version — everything verified"
                    : "the re-run against this version"}
                </button>
              </div>
            )}
          </div>
          <div className={styles.reviewActions}>
            <Button
              variant="danger"
              size="sm"
              disabled={decide.isPending}
              onClick={() => void onDecide(item, "reject")}
            >
              Reject
            </Button>
            <Button
              size="sm"
              disabled={decide.isPending}
              onClick={() => void onDecide(item, "accept")}
            >
              Accept
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function RepairQueue() {
  return (
    <div className={styles.stack}>
      <RepairReviews />
      <Queue />
    </div>
  );
}

function Queue() {
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
