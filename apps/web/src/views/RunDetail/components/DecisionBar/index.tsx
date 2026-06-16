import type { CheckpointView } from "@varys/review-contract";
import { Button, Check, X } from "@varys/ui";
import { useState } from "react";
import { useToast } from "../../../../context/toast";
import { useDecision } from "../../../../queries";
import { ApproveDialog } from "../ApproveDialog";
import styles from "./styles.module.scss";

export function DecisionBar({ checkpoint: cp, runId }: { checkpoint: CheckpointView; runId: string }) {
  const decision = useDecision(runId);
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);

  // Audit trail of the current golden baseline (who approved it, when), shown wherever
  // a baseline already exists for this checkpoint.
  const audit = cp.baselineApprovedBy ? (
    <span className={styles.audit}>
      Baseline approved by {cp.baselineApprovedBy}
      {cp.baselineApprovedAt ? ` · ${new Date(cp.baselineApprovedAt).toLocaleString()}` : ""}
    </span>
  ) : null;

  if (cp.resolution) {
    return (
      <div className={styles.bar}>
        <span className={styles.decided}>Decision recorded · {cp.resolution}</span>
        {audit}
      </div>
    );
  }

  const needsReview = cp.reviewState === "pending-baseline" || cp.reviewState === "diff";
  if (!needsReview) {
    return (
      <div className={styles.bar}>
        <span className={styles.decided}>Within threshold — no action needed</span>
        {audit}
      </div>
    );
  }

  function decide(action: "approve" | "reject") {
    decision.mutate(
      { name: cp.name, action },
      {
        onSuccess: () => toast(action === "approve" ? `Baseline replaced for “${cp.name}”` : `“${cp.name}” marked as regression`),
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t record decision"),
      },
    );
  }

  // A failed comparison (over threshold): the baseline may be the wrong/outdated image,
  // so approving promotes THIS run's screenshot to be the new golden baseline.
  const isDiff = cp.reviewState === "diff";

  return (
    <div className={styles.bar}>
      {isDiff ? (
        <span className={styles.hint}>
          Over threshold. If the baseline is outdated and this screenshot is correct, approve it to become the new
          baseline; reject if it’s a regression.
        </span>
      ) : (
        <span className={styles.spacer} />
      )}
      <Button variant="secondary" iconLeft={<X size={15} />} disabled={decision.isPending} onClick={() => decide("reject")} className={styles.reject}>
        Reject
      </Button>
      <Button variant="primary" iconLeft={<Check size={15} />} disabled={decision.isPending} onClick={() => setConfirming(true)} className={styles.approve}>
        {isDiff ? "Approve as new baseline" : "Approve"}
      </Button>
      {audit}
      <ApproveDialog open={confirming} name={cp.name} onClose={() => setConfirming(false)} onConfirm={() => decide("approve")} />
    </div>
  );
}
