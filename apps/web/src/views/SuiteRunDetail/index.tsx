import type { SuiteRunChild } from "@varys/review-contract";
import {
  ArrowLeft,
  Button,
  cx,
  ErrorState,
  IconButton,
  Play,
  SegmentedControl,
  type SegmentedOption,
  Skeleton,
  Squares,
  Trash,
} from "@varys/ui";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "../../context/confirm";
import { useRouter } from "../../context/router";
import { useRunDialog } from "../../context/run-dialog";
import { useToast } from "../../context/toast";
import { absoluteTime, duration, formatActor, relativeTime } from "../../lib/format";
import { StatusBadge } from "../../lib/status";
import {
  useDeleteRun,
  useDeleteSuiteRun,
  useRerunSuiteRun,
  useRunTest,
  useSuiteRun,
  suiteRunQueryKey,
} from "../../queries";
import styles from "./styles.module.scss";

/** Which children to show. `review` and `failed` are what you open a red fan-out to find; `all`
 *  is the default because a green suite has nothing to filter. */
type Filter = "all" | "failed" | "review" | "passed";
const FILTER_OPTIONS: SegmentedOption<Filter>[] = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "review", label: "Needs review" },
  { value: "passed", label: "Passed" },
];

function matches(child: SuiteRunChild, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "failed":
      return child.status === "failed";
    case "review":
      // A healed child is a queue item too — it verified on a repair nobody has accepted — so it
      // belongs with the things waiting on a person, even though its status reads `passed`.
      return child.status === "needs_review" || child.outcome === "healed";
    case "passed":
      return child.status === "passed" && child.outcome !== "healed";
  }
}

export function SuiteRunDetail({ suiteRunId }: { suiteRunId: string }) {
  const report = useSuiteRun(suiteRunId);
  const { navigate } = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { openRunDialog } = useRunDialog();
  const rerunSuite = useRerunSuiteRun();
  const delSuite = useDeleteSuiteRun();
  const rerunChild = useRunTest();
  const delChild = useDeleteRun();
  const [filter, setFilter] = useState<Filter>("all");

  if (report.isLoading) {
    return (
      <div>
        <Skeleton height={48} radius="var(--radius-md)" />
        <div className={styles.loadingStack}>
          <Skeleton height={140} radius="var(--radius-xl)" />
          <Skeleton height={320} radius="var(--radius-xl)" />
        </div>
      </div>
    );
  }

  if (report.isError || !report.data) {
    return <ErrorState title="Couldn’t load this suite run" onRetry={() => report.refetch()} />;
  }

  const r = report.data;
  const c = r.counts;
  const inFlight = r.status === "queued" || r.status === "running";
  // A fan-out whose suite is gone is history only: there is no membership left to re-resolve.
  const rerunBlocked = r.suiteId == null;

  const tiles = [
    { label: "Passed", value: c.passed, cls: styles.passed },
    // A SUBSET of Passed, not a sibling: a healed child verified, so it stays counted as passed
    // and the suite still reads green — this tile is how much of that green is resting on repairs
    // nobody has accepted yet. Shown only when there are any, so a suite with no repairs in play
    // is not asked to explain a zero.
    ...(c.healed > 0 ? [{ label: "Healed", value: c.healed, cls: styles.review }] : []),
    { label: "Review", value: c.needsReview, cls: styles.review },
    { label: "Failed", value: c.failed, cls: styles.failed },
    { label: "Running", value: c.running, cls: styles.neutral },
    { label: "Queued", value: c.queued, cls: styles.neutralMuted },
  ];

  /** Repeat the whole fan-out: same suite, same environments, membership re-resolved now. */
  function onRerunSuite() {
    rerunSuite.mutate(suiteRunId, {
      onSuccess: ({ suiteRunId: next }) => {
        toast(`Re-running “${r.suiteName}”`);
        navigate({ name: "suiteRunDetail", suiteRunId: next });
      },
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t re-run this suite"),
    });
  }

  async function onDeleteSuiteRun() {
    const ok = await confirm({
      title: inFlight ? "Cancel & delete suite run?" : "Delete suite run?",
      message: inFlight
        ? `“${r.suiteName}” is still running. This stops its ${c.total} child run${c.total === 1 ? "" : "s"} and deletes them along with the report (baselines are kept). This can’t be undone.`
        : `This deletes the “${r.suiteName}” fan-out and all ${c.total} of its child run${c.total === 1 ? "" : "s"} — their screenshots and history are removed (baselines are kept). This can’t be undone.`,
      confirmLabel: inFlight ? "Cancel & delete" : "Delete suite run",
      tone: "danger",
    });
    if (!ok) return;
    delSuite.mutate(suiteRunId, {
      onSuccess: () => {
        toast(inFlight ? "Suite run cancelled & deleted" : "Suite run deleted");
        navigate({ name: "suiteRuns" });
      },
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t delete suite run"),
    });
  }

  /**
   * Re-run ONE child, the same way the run-detail page does: same test, same environment, same
   * trace request, one click. The re-run is a STANDALONE run — it is not adopted into this
   * fan-out, because the report is a record of what that fan-out did, and back-filling it would
   * make a red suite silently turn green. So it opens on its own run page.
   */
  function onRerunChild(child: SuiteRunChild) {
    if (child.environmentMissing) {
      toast(`“${child.environment}” no longer exists — pick an environment for this run`);
      openRunDialog(child.testId);
      return;
    }
    rerunChild.mutate(
      { testId: child.testId, environmentId: child.environmentId ?? undefined, trace: child.trace },
      {
        onSuccess: ({ runId }) => {
          toast(`Re-running “${child.testName}” · ${child.environment}`);
          navigate({ name: "runDetail", runId });
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t start the re-run"),
      },
    );
  }

  async function onDeleteChild(child: SuiteRunChild) {
    const childInFlight = child.status === "queued" || child.status === "running";
    const ok = await confirm({
      title: childInFlight ? "Cancel & delete run?" : "Delete run?",
      message: childInFlight
        ? `“${child.testName}” · ${child.environment} is still running. This stops its execution and deletes the run (baselines are kept). This can’t be undone.`
        : `This deletes the “${child.testName}” · ${child.environment} run from this fan-out — its screenshots and history are removed (baselines are kept). The suite’s aggregate is recomputed without it. This can’t be undone.`,
      confirmLabel: childInFlight ? "Cancel & delete" : "Delete run",
      tone: "danger",
    });
    if (!ok) return;
    delChild.mutate(child.runId, {
      onSuccess: () => {
        toast(childInFlight ? "Run cancelled & deleted" : "Run deleted");
        // The aggregate is derived from the children, so losing one changes this report.
        qc.invalidateQueries({ queryKey: suiteRunQueryKey(suiteRunId) });
      },
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t delete run"),
    });
  }

  const children = r.children.filter((child) => matches(child, filter));

  return (
    <div>
      <header className={styles.header}>
        <IconButton
          icon={<ArrowLeft />}
          label="Back to suite runs"
          onClick={() => navigate({ name: "suiteRuns" })}
        />
        <div className={styles.titleBlock}>
          <div className={styles.titleRow}>
            <span className={styles.suiteName}>{r.suiteName}</span>
            <StatusBadge status={r.status} />
          </div>
          <div className={styles.meta}>
            <span className={styles.envs}>{r.environments.join(" · ")}</span> ·{" "}
            {r.testCount} test{r.testCount === 1 ? "" : "s"} × {r.environments.length} env
            {r.environments.length === 1 ? "" : "s"} = {c.total} run{c.total === 1 ? "" : "s"} ·{" "}
            {absoluteTime(r.runTimestamp)}
            {r.durationMs != null && ` · took ${duration(r.durationMs)}`}
            {r.triggeredBy && (
              <span title={`Triggered by ${r.triggeredBy}`}>
                {" "}
                · by {r.triggeredBy === "schedule" ? "Schedule" : formatActor(r.triggeredBy)}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          iconLeft={<Play size={15} />}
          disabled={rerunBlocked || rerunSuite.isPending}
          loading={rerunSuite.isPending}
          title={
            rerunBlocked
              ? "The suite behind this fan-out has been deleted — this report is history only"
              : `Run “${r.suiteName}” again against ${r.environments.join(", ")}, re-resolving its membership`
          }
          onClick={onRerunSuite}
        >
          Re-run suite
        </Button>
        <Button
          variant="secondary"
          iconLeft={<Squares size={15} />}
          onClick={() => navigate({ name: "suites" })}
        >
          Suites
        </Button>
        <Button
          variant="secondary"
          iconLeft={<Trash size={15} />}
          disabled={delSuite.isPending}
          loading={delSuite.isPending}
          onClick={onDeleteSuiteRun}
        >
          {inFlight ? "Cancel & delete" : "Delete"}
        </Button>
      </header>

      {r.environmentsMissing > 0 && (
        <div className={styles.warning}>
          {r.environmentsMissing} environment{r.environmentsMissing === 1 ? "" : "s"} this fan-out
          targeted {r.environmentsMissing === 1 ? "has" : "have"} since been deleted — a re-run will
          only cover the {r.environmentIds.length} that remain.
        </div>
      )}

      <div className={styles.tiles}>
        {tiles.map((t) => (
          <div key={t.label} className={cx(styles.tile, t.cls)}>
            <div className={styles.tileValue}>{t.value}</div>
            <div className={styles.tileLabel}>{t.label}</div>
          </div>
        ))}
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>Child runs</h3>
          <span className={styles.count}>
            {children.length} of {r.children.length}
          </span>
          <SegmentedControl
            ariaLabel="Filter child runs by outcome"
            options={FILTER_OPTIONS}
            value={filter}
            onValueChange={setFilter}
          />
        </div>
        {children.length === 0 ? (
          <div className={styles.filterEmpty}>
            {r.children.length === 0
              ? "Every child run of this fan-out has been deleted."
              : "No child runs match this filter."}
          </div>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thLeft}>Test</th>
                  <th>Environment</th>
                  <th>Status</th>
                  <th>Review</th>
                  <th>Duration</th>
                  <th className={styles.thRight}>When</th>
                  <th className={styles.thAction} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {children.map((child) => {
                  const childInFlight = child.status === "queued" || child.status === "running";
                  const open = () => navigate({ name: "runDetail", runId: child.runId });
                  return (
                    <tr
                      key={child.runId}
                      tabIndex={0}
                      className={styles.row}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") open();
                      }}
                    >
                      <td className={styles.tdTest}>
                        <div className={styles.testName}>{child.testName}</div>
                        {child.error && <div className={styles.error}>{child.error}</div>}
                      </td>
                      <td className={styles.env}>
                        {child.environment}
                        {child.environmentMissing && <span className={styles.missing}> · deleted</span>}
                      </td>
                      <td>
                        <StatusBadge status={child.outcome} />
                      </td>
                      <td className={styles.numeric}>
                        {child.pendingCheckpoints > 0
                          ? `${child.pendingCheckpoints} pending`
                          : "—"}
                      </td>
                      <td className={styles.numeric}>
                        {child.durationMs != null ? duration(child.durationMs) : "—"}
                      </td>
                      <td className={styles.when}>{relativeTime(child.runTimestamp)}</td>
                      <td className={styles.tdAction}>
                        <IconButton
                          variant="ghost"
                          size="sm"
                          icon={<Play size={14} />}
                          label={`Re-run ${child.testName} on ${child.environment}`}
                          className={styles.rowBtn}
                          disabled={rerunChild.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRerunChild(child);
                          }}
                        />
                        <IconButton
                          variant="ghost"
                          size="sm"
                          icon={<Trash size={14} />}
                          label={childInFlight ? "Cancel & delete run" : "Delete run"}
                          className={cx(styles.rowBtn, styles.deleteBtn)}
                          disabled={delChild.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            void onDeleteChild(child);
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
    </div>
  );
}
