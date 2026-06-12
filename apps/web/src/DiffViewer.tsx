import type { CheckpointView } from "@varys/review-contract";
import { useState } from "react";
import { useRunView } from "./queries";
import styles from "./DiffViewer.module.css";

/** Exactly two ways to look this slice (swipe + onion-skin are deferred). */
type ViewMode = "side-by-side" | "overlay";

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
        <h1>{data.testName}</h1>
        <p className={styles.meta}>
          {data.environment} · {new Date(data.runTimestamp).toLocaleString()} · {data.status}
        </p>
      </header>
      {data.checkpoints.map((cp) => (
        <CheckpointPanel key={cp.name} checkpoint={cp} />
      ))}
    </main>
  );
}

function CheckpointPanel({ checkpoint: cp }: { checkpoint: CheckpointView }) {
  const [mode, setMode] = useState<ViewMode>("side-by-side");
  const isFirstSeed = cp.reviewState === "pending-baseline";
  const hasDiff = cp.diffUrl != null && cp.baselineUrl != null;

  if (isFirstSeed) {
    return (
      <section className={styles.panel} aria-label={`Checkpoint ${cp.name}`}>
        <h2>{cp.name}</h2>
        <p role="status" className={styles.notice}>
          First approval — no prior baseline to diff against yet.
        </p>
        <figure className={styles.figure}>
          <figcaption>Candidate baseline (this run’s capture)</figcaption>
          {cp.actualUrl && <img className={styles.image} src={cp.actualUrl} alt="actual" />}
        </figure>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-label={`Checkpoint ${cp.name}`}>
      <h2>{cp.name}</h2>

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
