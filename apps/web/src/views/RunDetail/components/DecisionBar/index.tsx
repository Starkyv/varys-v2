import type { CheckpointView } from "@varys/review-contract";
import { Button, Camera } from "@varys/ui";
import { useState } from "react";
import { useToast } from "../../../../context/toast";
import { useDecision } from "../../../../queries";
import { ApproveDialog } from "../ApproveDialog";
import styles from "./styles.module.scss";

/**
 * The per-checkpoint action bar. Varys uses the test-runner model: a diff (or a first run with
 * no baseline yet) is a FAILURE, and the only action is to set THIS run's capture as the baseline
 * — when the change is correct, or to seed the first baseline. A real bug is left red and fixed in
 * the app; there is no "reject". A passing checkpoint can also be re-anchored to its current capture.
 */
export function DecisionBar({ checkpoint: cp, runId }: { checkpoint: CheckpointView; runId: string }) {
  const decision = useDecision(runId);
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);

  // Audit trail of the current golden baseline (who set it, when), shown wherever a baseline exists.
  const audit = cp.baselineApprovedBy ? (
    <span className={styles.audit}>
      Baseline set by {cp.baselineApprovedBy}
      {cp.baselineApprovedAt ? ` · ${new Date(cp.baselineApprovedAt).toLocaleString()}` : ""}
    </span>
  ) : null;

  // An unreached slot produced no capture, so every action here is meaningless — and "Approve
  // baseline" on one would be actively dangerous, since it would promise a golden image that does
  // not exist.
  if (cp.reviewState === "missing") {
    return (
      <div className={styles.bar}>
        <span className={styles.hint}>
          Nothing was captured for this checkpoint, so there is nothing to approve. Fix what stopped
          the run reaching it, then run again.
        </span>
        {audit}
      </div>
    );
  }

  if (cp.resolution) {
    return (
      <div className={styles.bar}>
        <span className={styles.decided}>
          {cp.resolution === "approved" ? "Baseline set" : "Marked as a bug"}
          {cp.resolvedBy ? ` by ${cp.resolvedBy}` : ""}
          {cp.resolvedAt ? ` · ${new Date(cp.resolvedAt).toLocaleString()}` : ""}
        </span>
        {audit}
      </div>
    );
  }

  function setBaseline() {
    decision.mutate(
      { name: cp.name, action: "approve" },
      {
        onSuccess: () => toast(`Baseline set for “${cp.name}”`),
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t set baseline"),
      },
    );
  }

  const isPassing = cp.reviewState === "passed";
  const isFirst = cp.reviewState === "pending-baseline";
  // A `context` checkpoint is judged, not measured — there is no threshold it could be within,
  // and for an Agent-Driven Test there is no pixel path at all. Saying "within threshold" here
  // hands a reader a number that was never computed, off a `threshold` column that exists only
  // because it is NOT NULL, and quietly contradicts the run's own contextual verdict.
  const isContext = cp.compareMode === "context";
  const hint =
    cp.reviewState === "diff"
      ? isContext
        ? "Judged as different from the baseline — this run failed. If the capture is correct, set it as the new baseline; if it’s a bug, fix it and run again."
        : "Differs from the baseline — this run failed. If the capture is correct, set it as the new baseline; if it’s a bug, fix it and re-run."
      : isFirst
        ? "No baseline yet — approve this capture to set the first baseline and start comparing."
        : isContext
          ? "Judged as matching the baseline. You can re-anchor it to this capture."
          : "Within threshold — matched the baseline. You can re-anchor it to this capture.";
  // "These two images are byte-identical" is a pixel fact. A context checkpoint has no diffScore
  // at all, so this stays false there rather than reading a null as a zero.
  const identical = isPassing && !isContext && cp.diffScore != null && cp.diffScore <= 0;

  return (
    <div className={styles.bar}>
      <span className={styles.hint}>{hint}</span>
      <Button
        variant={isPassing ? "secondary" : "primary"}
        iconLeft={<Camera size={15} />}
        disabled={decision.isPending}
        onClick={() => setConfirming(true)}
      >
        {isFirst ? "Approve baseline" : "Set as baseline"}
      </Button>
      {audit}
      <ApproveDialog
        open={confirming}
        name={cp.name}
        identical={identical}
        onClose={() => setConfirming(false)}
        onConfirm={() => setBaseline()}
      />
    </div>
  );
}
