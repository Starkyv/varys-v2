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
  /** True when the test references variables/secrets — it declares `variables`, or
   *  its definition still contains an unresolved `{{token}}`. The Run UI uses this to
   *  require an environment before the test can run (a no-variable test runs without
   *  one). Computed server-side from the latest version's definition. */
  needsEnvironment: boolean;
  /** The test's folder (organization metadata, relational — never part of the
   *  versioned definition). Null = Unfiled. */
  folderId: string | null;
  folderName: string | null;
  /** Free-form tags (many-to-many slicing across folder boundaries). */
  tags: string[];
}

/** A flat folder — each test's one browsable home (DESIGN §5). */
export interface FolderSummary {
  id: string;
  name: string;
  /** How many tests currently live in this folder. */
  testCount: number;
}

/** A suite — a named, saved selection of tests: the run unit slice 6 executes as
 *  `suite × env(s)` (DESIGN §5). This slice defines and manages them only. */
export interface SuiteSummary {
  id: string;
  name: string;
  /** How many tests the suite currently selects. */
  testCount: number;
}

/** A suite with its member tests (full summaries, so the UI gets folder/tags/
 *  needsEnvironment context without extra lookups). */
export interface SuiteView {
  id: string;
  name: string;
  tests: TestSummary[];
}

/**
 * An environment as the API returns it (list + get). Secret VALUES are never
 * returned — only their names — so a leaked screen or response can't expose them.
 * The same shape the env management UI renders and the Run picker lists.
 */
export interface EnvironmentView {
  id: string;
  name: string;
  /** Plain variable values (e.g. `baseUrl`), resolved into `{{tokens}}` at replay. */
  values: Record<string, string>;
  /** Names of the environment's secrets — values are write-only and never returned. */
  secretNames: string[];
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

/**
 * One row in the Runs history — every run, newest first, regardless of outcome
 * (unlike NeedsReviewItem, which only lists checkpoints awaiting a decision). Enough
 * to scan run outcomes and open any one in the viewer.
 */
export interface RunSummary {
  runId: string;
  testName: string;
  /** Environment name the run executed against ("default" when none). */
  environment: string;
  /** Run-level status: queued | running | passed | needs_review | failed. */
  status: string;
  runTimestamp: string;
  /** Why a `failed` run failed (the replay error); null otherwise. */
  error: string | null;
}

/** Aggregate child-run counts for a suite run — derived on read, never stored. */
export interface SuiteRunCounts {
  total: number;
  queued: number;
  running: number;
  passed: number;
  needsReview: number;
  failed: number;
}

/**
 * One row in the suite-runs history: a fan-out's parent (`suite × env(s)`,
 * DESIGN §6) with its derived aggregate. `suiteName` is a trigger-time snapshot,
 * so the report survives suite deletion/rename.
 */
export interface SuiteRunSummary {
  suiteRunId: string;
  suiteName: string;
  /** Distinct environment names the fan-out targeted ("default" when none). */
  environments: string[];
  /** Derived from the children: all-queued → queued; any queued/running →
   *  running; else failed > needs_review > passed. */
  status: string;
  counts: SuiteRunCounts;
  runTimestamp: string;
}

/** One child inside a suite-run report — an ordinary run, opened via `?run=`. */
export interface SuiteRunChild {
  runId: string;
  testName: string;
  /** Environment name this child ran against ("default" when none). */
  environment: string;
  status: string;
  error: string | null;
}

/** The suite-run report: the aggregate plus children in stable test×env order. */
export interface SuiteRunView extends SuiteRunSummary {
  children: SuiteRunChild[];
}

/** One step of a run, as a label for the failed-run step sequence. */
export interface StepLabel {
  /** 0-based position in the run's steps. */
  index: number;
  /** Human label, e.g. `click "Submit"` or `navigate to "{{baseUrl}}/"`. */
  label: string;
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
  /** For a `failed` run: the run's full step sequence (labels) so the viewer can show
   *  which step failed and which never ran. Empty for non-failed runs. */
  steps: StepLabel[];
  /** For a `failed` run: 0-based index into `steps` of the step that failed, or null
   *  when it failed before any step ran (e.g. environment resolution). */
  failedStepIndex: number | null;
  /** Artifact URL of the kept Playwright trace zip, or null when the trigger
   *  didn't request one (traces are per-trigger on demand only). */
  traceUrl: string | null;
  checkpoints: CheckpointView[];
}
