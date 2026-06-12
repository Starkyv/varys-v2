import type { CaptureMode, CheckpointView, Rect, StepLabel } from "@varys/review-contract";
import { useRef, useState } from "react";
import {
  useApproveAll,
  useDecision,
  usePersistMasks,
  useReEvaluate,
  useRunView,
} from "./queries";
import styles from "./DiffViewer.module.css";

/** A checkpoint still awaiting a decision (drives the run-level "Approve all"). */
function needsReview(cp: CheckpointView): boolean {
  return (cp.reviewState === "pending-baseline" || cp.reviewState === "diff") && !cp.resolution;
}

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
      {data.status === "failed" ? (
        <RunFailure error={data.error} steps={data.steps} failedStepIndex={data.failedStepIndex} />
      ) : data.checkpoints.length === 0 ? (
        <p role="status" className={styles.notice}>
          {data.status === "queued" || data.status === "running"
            ? "This run is still in progress — checkpoints will appear once it finishes."
            : "This run produced no checkpoints."}
        </p>
      ) : (
        <>
          {data.checkpoints.filter(needsReview).length > 0 && (
            <RunApproveAll
              runId={data.runId}
              count={data.checkpoints.filter(needsReview).length}
            />
          )}
          {data.checkpoints.map((cp) => (
            <CheckpointPanel key={cp.name} checkpoint={cp} runId={data.runId} />
          ))}
        </>
      )}
    </main>
  );
}

/**
 * Run-level bulk approval: resolve every checkpoint that still needs review in
 * one action. Gated behind the same irreversible hard-confirm as a single
 * approve, worded to name that it sets/replaces *multiple* baselines at once.
 */
function RunApproveAll({ runId, count }: { runId: string; count: number }) {
  const [confirming, setConfirming] = useState(false);
  const approveAll = useApproveAll(runId);

  return (
    <section className={styles.bulk} aria-label="Approve all in run">
      <button
        type="button"
        className={styles.approve}
        disabled={approveAll.isPending}
        onClick={() => setConfirming(true)}
      >
        Approve all ({count})
      </button>

      {approveAll.isError && (
        <p role="alert" className={styles.error}>
          Couldn’t approve all: {(approveAll.error as Error).message}
        </p>
      )}

      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm approve all"
          className={styles.dialog}
        >
          <p>
            Approving all permanently sets or replaces the baseline for every one of the {count}{" "}
            checkpoints that need review in this run — there is no undo.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.approve}
              onClick={() => {
                setConfirming(false);
                approveAll.mutate();
              }}
            >
              Confirm approve all
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * A failed run errored during replay before it could capture or diff anything — so
 * there is no diff to show. Instead of a lone message, surface the run's whole step
 * sequence with the failing step marked (and the error inline against it), so the
 * reviewer sees exactly where it broke and which steps never ran. Falls back to the
 * bare message when the failure happened before any step (e.g. env resolution).
 */
function RunFailure({
  error,
  steps,
  failedStepIndex,
}: {
  error: string | null;
  steps: StepLabel[];
  failedStepIndex: number | null;
}) {
  const hasSequence = failedStepIndex != null && steps.length > 0;

  return (
    <section className={styles.failure} aria-label="Run failed">
      <h2>
        {hasSequence
          ? `This run failed at step ${failedStepIndex + 1} of ${steps.length}`
          : "This run failed before any checkpoint was captured"}
      </h2>

      {failedStepIndex != null && steps.length > 0 ? (
        <ol className={styles.stepList}>
          {steps.map((s) => {
            const state =
              s.index < failedStepIndex
                ? "ran"
                : s.index === failedStepIndex
                  ? "failed"
                  : "notrun";
            return (
              <li key={s.index} className={`${styles.step} ${styles[`step_${state}`]}`}>
                <span className={styles.stepMark} aria-hidden>
                  {state === "ran" ? "✓" : state === "failed" ? "✗" : "•"}
                </span>
                <span className={styles.stepNum}>{s.index + 1}</span>
                <span className={styles.stepLabel}>{s.label}</span>
                {state === "notrun" && <span className={styles.stepNote}>didn’t run</span>}
                {state === "failed" && (
                  <pre className={styles.stepError}>{error ?? "No error message was recorded."}</pre>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <>
          <p>The replay errored before running any step. The recorded error was:</p>
          <pre className={styles.failureMessage}>{error ?? "No error message was recorded."}</pre>
        </>
      )}
    </section>
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
  const [tuning, setTuning] = useState(false);
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

          {hasDiff && (
            <div className={styles.tuneToggleRow}>
              <button
                type="button"
                className={styles.modeButton}
                aria-pressed={tuning}
                onClick={() => setTuning((t) => !t)}
              >
                {tuning ? "Hide editor" : "Tune masks & threshold"}
              </button>
            </div>
          )}
          {hasDiff && tuning && <TuningEditor checkpoint={cp} runId={runId} />}
        </>
      )}

      <Decision checkpoint={cp} runId={runId} />
    </section>
  );
}

/** Normalize two corner points into a positive-area rectangle. */
function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    width: Math.round(Math.abs(a.x - b.x)),
    height: Math.round(Math.abs(a.y - b.y)),
  };
}

/**
 * The in-viewer tuning editor (the slice's novel HITL surface). The reviewer draws
 * mask rectangles over the captured image to suppress volatile regions AND nudges
 * the per-checkpoint threshold; each change re-evaluates the diff against the
 * STORED baseline+actual server-side (no re-run) and shows the new verdict live.
 * "Save" persists masks + threshold as a new test version and re-judges this
 * checkpoint, so a now-clean checkpoint flips to passed.
 *
 * Masks are stored in screenshot-pixel (natural image) space; we draw in displayed
 * space and convert via the image's natural/displayed ratio, then position the
 * overlays with percentages so they track the responsively-scaled image.
 */
function TuningEditor({ checkpoint: cp, runId }: { checkpoint: CheckpointView; runId: string }) {
  const [masks, setMasks] = useState<Rect[]>(cp.masks);
  const [threshold, setThreshold] = useState<number>(cp.threshold);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const reEval = useReEvaluate(runId, cp.name);
  const persist = usePersistMasks(runId, cp.name);

  // Drawing image: the actual capture (what diverged). Masks apply to both sides.
  const drawSrc = cp.actualUrl;

  /** Pointer (client) coords → natural image pixels, clamped to the image. */
  const toNatural = (clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const box = img.getBoundingClientRect();
    const sx = img.naturalWidth / box.width;
    const sy = img.naturalHeight / box.height;
    return {
      x: Math.max(0, Math.min(img.naturalWidth, (clientX - box.left) * sx)),
      y: Math.max(0, Math.min(img.naturalHeight, (clientY - box.top) * sy)),
    };
  };

  // Any change to masks or threshold previews the same way: re-diff the stored
  // artifacts with the candidate masks + threshold (no re-run).
  const reevaluate = (m: Rect[], t: number) => reEval.mutate({ masks: m, threshold: t });
  const applyMasks = (next: Rect[]) => {
    setMasks(next);
    reevaluate(next, threshold);
  };
  const changeThreshold = (t: number) => {
    setThreshold(t);
    reevaluate(masks, t);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragStart.current = toNatural(e.clientX, e.clientY);
    setDraft({ ...dragStart.current, width: 0, height: 0 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    setDraft(rectFrom(dragStart.current, toNatural(e.clientX, e.clientY)));
  };
  const onPointerUp = () => {
    const d = draft;
    dragStart.current = null;
    setDraft(null);
    if (d && d.width >= 4 && d.height >= 4) applyMasks([...masks, d]);
  };

  /** Natural-pixel rect → percentage box over the (scaled) image. */
  const pct = (r: Rect): React.CSSProperties =>
    nat
      ? {
          left: `${(r.x / nat.w) * 100}%`,
          top: `${(r.y / nat.h) * 100}%`,
          width: `${(r.width / nat.w) * 100}%`,
          height: `${(r.height / nat.h) * 100}%`,
        }
      : { display: "none" };

  const result = reEval.data;

  return (
    <div className={styles.maskEditor}>
      <p className={styles.maskHelp}>
        Drag on the image to mask a volatile region, and adjust the threshold for sensitivity.
        Masked areas are ignored by the diff. Changes preview instantly; <strong>Save</strong>{" "}
        persists the masks and threshold for future runs.
      </p>

      {/** biome-ignore lint/a11y/noStaticElementInteractions: drawing surface */}
      <div className={styles.maskStage} style={{ position: "relative", display: "inline-block" }}>
        {drawSrc && (
          <img
            ref={imgRef}
            className={styles.image}
            src={drawSrc}
            alt="capture to mask"
            onLoad={(e) =>
              setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
          />
        )}
        <div
          className={styles.maskLayer}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {masks.map((m, i) => (
            <div key={`${m.x},${m.y},${m.width},${m.height},${i}`} className={styles.maskRect} style={pct(m)}>
              <button
                type="button"
                className={styles.maskRemove}
                title="Remove mask"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => applyMasks(masks.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          {draft && <div className={styles.maskDraft} style={pct(draft)} />}
        </div>
      </div>

      <div className={styles.maskTools}>
        <span className={styles.maskCount}>
          {masks.length} mask{masks.length === 1 ? "" : "s"}
        </span>
        {masks.length > 0 && (
          <button type="button" className={styles.maskClear} onClick={() => applyMasks([])}>
            Clear all
          </button>
        )}
      </div>

      <div className={styles.thresholdRow}>
        <label htmlFor={`thr-${cp.name}`}>Threshold</label>
        <input
          id={`thr-${cp.name}`}
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={threshold}
          onChange={(e) => changeThreshold(Number(e.target.value))}
        />
        <span className={styles.thresholdVal}>{threshold.toFixed(3)}</span>
      </div>

      <div className={styles.maskPreview}>
        {reEval.isPending ? (
          <p className={styles.notice}>Re-evaluating…</p>
        ) : result ? (
          <>
            <p className={result.verdict === "match" ? styles.previewMatch : styles.previewDiff}>
              Preview: <strong>{result.verdict === "match" ? "within threshold" : "still differs"}</strong>{" "}
              — score {result.diffScore.toFixed(4)} / threshold {result.threshold}
            </p>
            {result.diffImage && (
              <figure className={styles.figure}>
                <figcaption>Preview diff (masked)</figcaption>
                <img className={styles.image} src={result.diffImage} alt="masked diff preview" />
              </figure>
            )}
          </>
        ) : (
          <p className={styles.notice}>Draw a mask to preview the re-evaluated diff.</p>
        )}
        {reEval.isError && (
          <p role="alert" className={styles.error}>
            {(reEval.error as Error).message}
          </p>
        )}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.approve}
          disabled={persist.isPending}
          onClick={() => persist.mutate({ masks, threshold })}
        >
          Save masks &amp; threshold
        </button>
      </div>
      {persist.isError && (
        <p role="alert" className={styles.error}>
          {(persist.error as Error).message}
        </p>
      )}
    </div>
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
