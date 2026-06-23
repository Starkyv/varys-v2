import { ArrowLeft, Button, Check, ErrorState, ExternalLink, IconButton, Skeleton, Trash } from "@varys/ui";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { createElement, useEffect, useMemo, useState } from "react";
import { useConfirm } from "../../context/confirm";
import { useRouter } from "../../context/router";
import { useToast } from "../../context/toast";
import { absoluteTime, formatActor } from "../../lib/format";
import { StatusBadge } from "../../lib/status";
import { useApproveAll, useDeleteRun, useRunView, useUpdateRunNotes } from "../../queries";
import { NotesCard } from "../../components/NotesCard";
import { ApproveDialog } from "./components/ApproveDialog";
import { CheckpointViewer } from "./components/CheckpointViewer";
import {
  buildTimelineRows,
  defaultSelectedIndex,
  needsDecision,
  RunTimeline,
  verbIcon,
} from "./components/RunTimeline";
import { StepDetail } from "./components/StepDetail";
import styles from "./styles.module.scss";

/**
 * The self-hosted Playwright trace viewer (`/trace-viewer`, served by the API) —
 * same origin as the trace artifact, so the browser won't block the fetch the way
 * the hosted viewer would.
 */
function timelineViewerUrl(traceUrl: string): string {
  const absolute = new URL(traceUrl, window.location.origin).href;
  return `/trace-viewer/index.html?trace=${encodeURIComponent(absolute)}`;
}

export function RunDetail({ runId }: { runId: string }) {
  const run = useRunView(runId);
  const { navigate } = useRouter();
  const { toast } = useToast();
  const approveAll = useApproveAll(runId);
  const del = useDeleteRun();
  const notesMutation = useUpdateRunNotes(runId);
  const confirm = useConfirm();
  const reduce = useReducedMotion();

  // `null` = follow the computed default; a number = an explicit user pick.
  const [picked, setPicked] = useState<number | null>(null);
  const [approveAllOpen, setApproveAllOpen] = useState(false);

  // Reset the selection when navigating between runs (the component instance is reused).
  useEffect(() => setPicked(null), [runId]);

  const rows = useMemo(() => (run.data ? buildTimelineRows(run.data) : []), [run.data]);

  if (run.isLoading) {
    return (
      <div>
        <Skeleton height={48} radius="var(--radius-md)" />
        <div className={styles.loadingGrid}>
          <Skeleton height={520} radius="var(--radius-xl)" />
          <Skeleton height={520} radius="var(--radius-xl)" />
        </div>
      </div>
    );
  }

  if (run.isError || !run.data) {
    return <ErrorState title="Couldn’t load this run" onRetry={() => run.refetch()} />;
  }

  const data = run.data;
  const hasTimeline = rows.length > 0;
  const inProgress = (data.status === "queued" || data.status === "running") && !hasTimeline;
  const pendingCount = data.checkpoints.filter(needsDecision).length;
  const summary = `${data.timeline.length} step${data.timeline.length === 1 ? "" : "s"} · ${data.checkpoints.length} checkpoint${
    data.checkpoints.length === 1 ? "" : "s"
  }`;

  const defaultSel = defaultSelectedIndex(data, rows);
  const selectedIndex = picked ?? defaultSel;
  const selectedRow = rows.find((r) => r.index === selectedIndex) ?? rows[0];

  const openTrace = () => window.open(timelineViewerUrl(data.traceUrl as string), "_blank", "noopener");

  const inFlight = data.status === "queued" || data.status === "running";
  async function onDelete() {
    const ok = await confirm({
      title: "Delete run?",
      message: `This deletes the run of “${data.testName}” — its screenshots and history are removed (baselines are kept). This can’t be undone.`,
      confirmLabel: "Delete run",
      tone: "danger",
    });
    if (!ok) return;
    del.mutate(runId, {
      onSuccess: () => {
        toast("Run deleted");
        navigate({ name: "runs" });
      },
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t delete run"),
    });
  }

  return (
    <div>
      <header className={styles.header}>
        <IconButton icon={<ArrowLeft />} label="Back to runs" onClick={() => navigate({ name: "runs" })} />
        <div className={styles.titleBlock}>
          <div className={styles.titleRow}>
            <span className={styles.testName}>{data.testName}</span>
            <StatusBadge status={data.outcome} />
          </div>
          <div className={styles.meta}>
            <span className={styles.env}>{data.environment}</span> · {absoluteTime(data.runTimestamp)}
            {data.triggeredBy && (
              <span
                title={`Triggered by ${data.triggeredBy}${data.triggerSource ? ` (${data.triggerSource})` : ""}`}
              >
                {" "}
                · by {formatActor(data.triggeredBy)}
                {data.triggerSource ? ` (${data.triggerSource})` : ""}
              </span>
            )}
          </div>
        </div>
        {data.traceUrl && (
          <Button variant="secondary" iconLeft={<ExternalLink size={15} />} onClick={openTrace}>
            Open Playwright trace
          </Button>
        )}
        {hasTimeline && pendingCount > 0 && (
          <Button variant="primary" iconLeft={<Check size={15} />} onClick={() => setApproveAllOpen(true)}>
            Approve all
          </Button>
        )}
        <Button
          variant="ghost"
          iconLeft={<Trash size={15} />}
          onClick={() => void onDelete()}
          disabled={inFlight || del.isPending}
          title={inFlight ? "Can’t delete a run that’s still in progress" : "Delete this run"}
        >
          Delete
        </Button>
      </header>

      <div className={styles.notes}>
        <NotesCard
          notes={data.notes}
          saving={notesMutation.isPending}
          placeholder="Add a note about this run — what you were checking, an anomaly, a follow-up…"
          onSave={(text) =>
            notesMutation.mutateAsync(text).then(
              () => toast("Note saved"),
              (e) => {
                toast(e instanceof Error ? e.message : "Couldn’t save note");
                throw e;
              },
            )
          }
        />
      </div>

      {!hasTimeline ? (
        <div className={styles.notice}>
          {inProgress
            ? "This run is still in progress — the timeline fills in as each step executes."
            : "This run recorded no steps."}
        </div>
      ) : (
        <div className={styles.timelineGrid}>
          <RunTimeline rows={rows} selectedIndex={selectedIndex} onSelect={setPicked} summary={summary} error={data.error} />

          <div className={styles.sticky}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={selectedIndex}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {selectedRow?.kind === "checkpoint" ? (
                  <CheckpointViewer
                    key={`${selectedRow.checkpoint.name}-${selectedRow.index}`}
                    checkpoint={selectedRow.checkpoint}
                    runId={data.runId}
                    target={data.fingerprints[selectedRow.index] ?? null}
                  />
                ) : selectedRow ? (
                  <StepDetail
                    icon={createElement(verbIcon(selectedRow.label), { size: 17 })}
                    label={selectedRow.label}
                    outcome={
                      selectedRow.kind === "never" ? "never" : selectedRow.failing ? "failed" : "passed"
                    }
                    startedAt={data.timeline.find((t) => t.index === selectedRow.index)?.startedAt}
                    durationMs={selectedRow.kind === "never" ? null : selectedRow.durationMs}
                    error={data.error}
                    traceUrl={data.traceUrl}
                    onOpenTrace={openTrace}
                    target={data.fingerprints[selectedRow.index] ?? null}
                  />
                ) : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      )}

      <ApproveDialog
        open={approveAllOpen}
        count={pendingCount}
        onClose={() => setApproveAllOpen(false)}
        onConfirm={() =>
          approveAll.mutate(undefined, {
            onSuccess: (r) => toast(`Approved ${r.approved} checkpoint${r.approved === 1 ? "" : "s"}`),
            onError: (e) => toast(e instanceof Error ? e.message : "Approve all failed"),
          })
        }
      />
    </div>
  );
}
