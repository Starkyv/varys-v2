import type { CaptureMode, CheckpointView } from "@varys/review-contract";
import { useState } from "react";
import { useDecision, useRunView } from "./queries";
import styles from "./DiffViewer.module.css";

/** Exactly two ways to look this slice (swipe + onion-skin are deferred). */
type ViewMode = "side-by-side" | "overlay";

/** Human label for how the checkpoint was captured. */
const MODE_LABEL: Record<CaptureMode, string> = {
  element: "Element",
  fullpage: "Full page",
  region: "Region",
};

/**
 * The diff viewer: given a run id (deep link), fetch the review read-model and
 * show, per checkpoint, the baseline / actual / diff images the server produced.
 * The verdict is *displayed*, never recomputed here. A first-seed checkpoint
 * (`pending-baseline`) has no prior baseline and nothing to diff, so it shows the
 * captured actual as the candidate baseline and a "first approval" affordance.
 */
export function DiffViewer({ runId }: { runId: string }) {
  const { data, isLoading, isError, error } = useRunView(runId);

  if (isLoading) {
    return (
      <p role="status" className={styles.notice}>
        Loading run…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className={styles.error}>
        Couldn’t load this run: {(error as Error).message}
      </p>
    );
  }
  if (!data) return null;

  return (
    <main className={styles.viewer}>
      <header className={styles.header}>
        <a className={styles.back} href="/">
          ← Review queue
        </a>
        <h1>{data.testName}</h1>
        <p className={styles.meta}>
          {data.environment} · {new Date(data.runTimestamp).toLocaleString()} · {data.status}
        </p>
      </header>
      {data.checkpoints.map((cp) => (
        <CheckpointPanel key={cp.name} checkpoint={cp} runId={data.runId} />
      ))}
    </main>
  );
}

function CheckpointPanel({
  checkpoint: cp,
  runId,
}: {
  checkpoint: CheckpointView;
  runId: string;
}) {
  const [mode, setMode] = useState<ViewMode>("side-by-side");
  const isFirstSeed = cp.reviewState === "pending-baseline";
  const hasDiff = cp.diffUrl != null && cp.baselineUrl != null;

  return (
    <section className={styles.panel} aria-label={`Checkpoint ${cp.name}`}>
      <h2>
        {cp.name} <span className={styles.mode}>{MODE_LABEL[cp.captureMode]}</span>
      </h2>

      {isFirstSeed ? (
        <>
          <p role="status" className={styles.notice}>
            First approval — no prior baseline to diff against yet.
          </p>
          <figure className={styles.figure}>
            <figcaption>Candidate baseline (this run’s capture)</figcaption>
            {cp.actualUrl && <img className={styles.image} src={cp.actualUrl} alt="actual" />}
          </figure>
        </>
      ) : (
        <>
          <Verdict checkpoint={cp} />

          <div className={styles.modes} role="group" aria-label="View mode">
            <button
              type="button"
              className={styles.modeButton}
              aria-pressed={mode === "side-by-side"}
              onClick={() => setMode("side-by-side")}
            >
              Side by side
            </button>
            {hasDiff && (
              <button
                type="button"
                className={styles.modeButton}
                aria-pressed={mode === "overlay"}
                onClick={() => setMode("overlay")}
              >
                Diff highlight
              </button>
            )}
          </div>

          {mode === "overlay" && hasDiff ? (
            <figure className={styles.figure}>
              <figcaption>Diff (changed pixels highlighted)</figcaption>
              {/* hasDiff guarantees diffUrl is set */}
              <img className={styles.image} src={cp.diffUrl as string} alt="diff highlight" />
            </figure>
          ) : (
            <div className={styles.images}>
              {cp.baselineUrl && (
                <figure className={styles.figure}>
                  <figcaption>Baseline</figcaption>
                  <img className={styles.image} src={cp.baselineUrl} alt="baseline" />
                </figure>
              )}
              {cp.actualUrl && (
                <figure className={styles.figure}>
                  <figcaption>Actual</figcaption>
                  <img className={styles.image} src={cp.actualUrl} alt="actual" />
                </figure>
              )}
            </div>
          )}
        </>
      )}

      <Decision checkpoint={cp} runId={runId} />
    </section>
  );
}

/** The server-computed verdict, displayed (never recomputed on the client). */
function Verdict({ checkpoint: cp }: { checkpoint: CheckpointView }) {
  return (
    <dl className={styles.verdict}>
      <div className={styles.verdictItem}>
        <dt>Diff score</dt>
        <dd>{cp.diffScore != null ? cp.diffScore.toFixed(4) : "—"}</dd>
      </div>
      <div className={styles.verdictItem}>
        <dt>Threshold</dt>
        <dd>{cp.threshold}</dd>
      </div>
      <div className={styles.verdictItem}>
        <dt>Healed</dt>
        <dd>{cp.healed ? "yes" : "no"}</dd>
      </div>
    </dl>
  );
}

/**
 * The decision surface. Approve is gated behind a blocking hard-confirm naming the
 * irreversible consequence (the sole guard on the product's only unrecoverable
 * action); Reject is not (it changes no baseline). A checkpoint the server reports
 * as already-resolved renders as decided rather than offering a stale approve.
 */
function Decision({ checkpoint: cp, runId }: { checkpoint: CheckpointView; runId: string }) {
  const [confirming, setConfirming] = useState(false);
  const decision = useDecision(runId);

  if (cp.resolution) {
    return (
      <p role="status" className={styles.decided}>
        Already {cp.resolution}.
      </p>
    );
  }

  const needsReview = cp.reviewState === "pending-baseline" || cp.reviewState === "diff";
  if (!needsReview) return null;

  const replaces = cp.reviewState === "diff";

  return (
    <div className={styles.decision}>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.approve}
          disabled={decision.isPending}
          onClick={() => setConfirming(true)}
        >
          Approve
        </button>
        <button
          type="button"
          className={styles.reject}
          disabled={decision.isPending}
          onClick={() => decision.mutate({ name: cp.name, action: "reject" })}
        >
          Reject
        </button>
      </div>

      {decision.isError && (
        <p role="alert" className={styles.error}>
          Couldn’t record your decision: {(decision.error as Error).message}
        </p>
      )}

      {confirming && (
        <div role="dialog" aria-modal="true" aria-label="Confirm approval" className={styles.dialog}>
          <p>
            {replaces
              ? "Approving permanently replaces the current baseline with this capture — there is no undo."
              : "Approving makes this capture the baseline — future runs compare against it. There is no undo."}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.approve}
              onClick={() => {
                setConfirming(false);
                decision.mutate({ name: cp.name, action: "approve" });
              }}
            >
              Confirm approve
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
