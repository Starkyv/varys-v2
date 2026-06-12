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

/** One checkpoint within a run, as the reviewer sees it. */
export interface CheckpointView {
  /** Checkpoint (screenshot) name within the test. */
  name: string;
  reviewState: ReviewState;
  /** Pixel-diff score the server computed; null on a first seed (nothing to diff). */
  diffScore: number | null;
  /** The per-checkpoint threshold the diff was judged against. */
  threshold: number;
  /** Whether the locator fell back to a lower-priority signal during the run. */
  healed: boolean;
  /** Authenticated artifact-route URLs. baseline/diff are null on a first seed. */
  actualUrl: string | null;
  baselineUrl: string | null;
  diffUrl: string | null;
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
  checkpoints: CheckpointView[];
}
