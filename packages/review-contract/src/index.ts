/**
 * The shared, typed per-checkpoint review read-model — the single contract the
 * NestJS API produces and the `apps/web` review SPA consumes, so the two can't
 * silently drift (PRD: "build the read-model contract first").
 *
 * Pure types, zero runtime dependencies: the SPA imports this without dragging in
 * drizzle/pg or any Node-only code. The verdict (reviewState, diffScore) is computed
 * server-side and only *displayed* here — never recomputed on the client.
 */

/** The two states that need a human decision, plus the resolved `passed`. */
export type ReviewState = "pending-baseline" | "diff" | "passed";

/** How a checkpoint was captured (absent in old definitions ⇒ `element`). */
export type CaptureMode = "element" | "fullpage" | "region";

/** The audited decision a reviewer can take on a checkpoint. */
export type Resolution = "approved" | "rejected";

/** A rectangle in screenshot-pixel space (mask region; matches the step schema). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Candidate masks/threshold a reviewer is trying out (re-evaluate) or committing
 *  (persist). Both fields optional so the same shape serves masks (Issue 4) and
 *  threshold tuning (Issue 5). */
export interface TuningInput {
  masks?: Rect[];
  threshold?: number;
}

/** Result of a re-evaluate (preview) — the diff recomputed against the stored
 *  baseline+actual with candidate masks/threshold, with no new capture (no re-run). */
export interface ReEvaluation {
  verdict: "match" | "diff";
  /** Mismatched-pixel ratio in [0,1]. */
  diffScore: number;
  /** The threshold the verdict was judged against. */
  threshold: number;
  /** Transient diff image as a data URL (`data:image/png;base64,…`); not persisted. */
  diffImage: string | null;
}

/** Result of persisting masks/threshold: the named checkpoint's run_result was
 *  re-judged against the stored artifacts, and a new test_version was written. */
export interface PersistResult {
  /** The checkpoint's new review state (`passed` once within threshold). */
  reviewState: ReviewState;
  diffScore: number;
  threshold: number;
  /** The version number of the newly written test_version. */
  version: number;
}

/** A saved test (recording), as listed in the Tests view. */
export interface TestSummary {
  id: string;
  name: string;
  createdAt: string;
}

/** One checkpoint within a run, as the reviewer sees it. */
export interface CheckpointView {
  /** Checkpoint (screenshot) name within the test. */
  name: string;
  reviewState: ReviewState;
  /** How this checkpoint was captured (element / full-page / region). */
  captureMode: CaptureMode;
  /** The recorded decision, or null while the checkpoint still needs review. */
  resolution: Resolution | null;
  /** Pixel-diff score the server computed; null on a first seed (nothing to diff). */
  diffScore: number | null;
  /** The per-checkpoint threshold the diff was judged against. */
  threshold: number;
  /** Whether the locator fell back to a lower-priority signal during the run. */
  healed: boolean;
  /** The checkpoint's current masks (from the latest test version) — the regions
   *  the diff ignores; what the in-viewer mask editor renders and edits. */
  masks: Rect[];
  /** Authenticated artifact-route URLs. baseline/diff are null on a first seed. */
  actualUrl: string | null;
  baselineUrl: string | null;
  diffUrl: string | null;
}

/**
 * One entry in the "needs review" list — a checkpoint currently awaiting a human
 * decision (`pending-baseline` or `diff`), with just enough context to triage and
 * open it. Not the slice-7 dashboard; a flat list, enough to find work.
 */
export interface NeedsReviewItem {
  runId: string;
  testName: string;
  environment: string;
  runTimestamp: string;
  checkpointName: string;
  /** Why it needs review: `pending-baseline` (first approval) or `diff`. */
  reviewState: Exclude<ReviewState, "passed">;
}

/** A run and its checkpoints, with the identifying context the reviewer needs. */
export interface RunView {
  runId: string;
  /** Run-level status taxonomy (queued | running | passed | needs_review | failed). */
  status: string;
  /** Test name, for display without a separate lookup. */
  testName: string;
  /** Environment name the run executed against ("default" when none was chosen). */
  environment: string;
  /** When the run was created, ISO 8601. */
  runTimestamp: string;
  /** Why a `failed` run failed (the replay error); null otherwise. A failed run
   *  captures no checkpoints, so this is what the viewer shows instead. */
  error: string | null;
  checkpoints: CheckpointView[];
}
