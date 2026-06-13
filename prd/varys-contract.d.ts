/**
 * Varys API contract — machine-readable type summary for UI generation.
 *
 * Self-contained snapshot (no imports) of `@varys/review-contract` plus the API
 * client request bodies and an endpoint → type map. Upload alongside the UI brief
 * so generated components bind to the EXACT read-model fields and endpoints.
 *
 * Source of truth: packages/review-contract/src/index.ts + apps/web/src/api.ts.
 * All artifact URLs are same-origin authenticated routes; baseline/diff are null on
 * a first seed (nothing to diff yet). Status strings use the run-level taxonomy.
 */

/* ───────────────────────────── Primitives ───────────────────────────── */

/** Checkpoint review state: the two that need a human decision, plus resolved. */
export type ReviewState = "pending-baseline" | "diff" | "passed";

/** How a checkpoint was captured (absent in old definitions ⇒ "element"). */
export type CaptureMode = "element" | "fullpage" | "region";

/** The audited decision a reviewer can record on a checkpoint. */
export type Resolution = "approved" | "rejected";

/** Run-level status taxonomy. */
export type RunStatus = "queued" | "running" | "passed" | "needs_review" | "failed";

/** A rectangle in screenshot-pixel space (mask region). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* ────────────────────────── Tests & organization ────────────────────── */

/** A saved test (recording), as listed in the Tests view. */
export interface TestSummary {
  id: string;
  name: string;
  createdAt: string;
  /** True when the test references variables/secrets — the Run UI must then require
   *  an environment before it can run (a no-variable test runs without one). */
  needsEnvironment: boolean;
  /** The test's folder (relational organization metadata). null = Unfiled. */
  folderId: string | null;
  folderName: string | null;
  /** Free-form tags (many-to-many slicing across folders). */
  tags: string[];
}

/** A flat folder — each test's one browsable home. */
export interface FolderSummary {
  id: string;
  name: string;
  testCount: number;
}

/** A suite — a named, saved selection of tests; the run unit (suite × env(s)). */
export interface SuiteSummary {
  id: string;
  name: string;
  testCount: number;
}

/** A suite with its member tests (full summaries for folder/tags/needsEnvironment). */
export interface SuiteView {
  id: string;
  name: string;
  tests: TestSummary[];
}

/* ───────────────────────────── Environments ─────────────────────────── */

/** An environment. Secret VALUES are never returned — only their names. */
export interface EnvironmentView {
  id: string;
  name: string;
  /** Plain variable values (e.g. baseUrl), resolved into {{tokens}} at replay. */
  values: Record<string, string>;
  /** Names of the environment's secrets — values are write-only, never returned. */
  secretNames: string[];
}

/* ───────────────────────── Runs, checkpoints, timeline ───────────────── */

/** One checkpoint within a run, as the reviewer sees it. */
export interface CheckpointView {
  name: string;
  reviewState: ReviewState;
  captureMode: CaptureMode;
  /** The recorded decision, or null while the checkpoint still needs review. */
  resolution: Resolution | null;
  /** Pixel-diff score the server computed; null on a first seed (nothing to diff). */
  diffScore: number | null;
  /** The per-checkpoint threshold the diff was judged against. */
  threshold: number;
  /** Whether the locator fell back to a lower-priority signal during the run. */
  healed: boolean;
  /** Current masks (regions the diff ignores) — what the mask editor renders. */
  masks: Rect[];
  /** Authenticated artifact-route URLs. baseline/diff are null on a first seed. */
  actualUrl: string | null;
  baselineUrl: string | null;
  diffUrl: string | null;
}

/** A label for one step of a run's full sequence (used by the failed-run view). */
export interface StepLabel {
  /** 0-based position in the run's steps. */
  index: number;
  /** Human label, e.g. `click "Submit"` or `navigate to "{{baseUrl}}/"`. */
  label: string;
}

/** One EXECUTED step of a run, with timing + outcome (per-step timeline, every run).
 *  Steps never reached are simply absent (derive "didn't run" from the definition). */
export interface StepRun {
  index: number;
  label: string;
  /** The checkpoint name when this is a screenshot step; null otherwise (join key). */
  checkpointName: string | null;
  /** ISO 8601 start time. */
  startedAt: string;
  /** Duration in ms (to-failure for the failing step). */
  durationMs: number;
  outcome: "passed" | "failed";
}

/** A run and its checkpoints — the per-run review read-model. */
export interface RunView {
  runId: string;
  status: RunStatus;
  testName: string;
  /** Environment name the run executed against ("default" when none). */
  environment: string;
  runTimestamp: string;
  /** Why a `failed` run failed (replay error); null otherwise. A failed run captures
   *  no checkpoints, so this is shown instead. */
  error: string | null;
  /** For a `failed` run: the full step sequence (labels) so the viewer can show which
   *  step failed and which never ran. Empty for non-failed runs. */
  steps: StepLabel[];
  /** For a `failed` run: 0-based index into `steps` of the failing step, or null when
   *  it failed before any step ran (e.g. environment resolution). */
  failedStepIndex: number | null;
  /** Artifact URL of the kept Playwright trace zip, or null when not requested. */
  traceUrl: string | null;
  /** Per-step execution timeline (every run), in order. Empty until the run starts. */
  timeline: StepRun[];
  checkpoints: CheckpointView[];
}

/** One row in the "needs review" list — a checkpoint awaiting a decision. */
export interface NeedsReviewItem {
  runId: string;
  testName: string;
  environment: string;
  runTimestamp: string;
  checkpointName: string;
  /** Why it needs review: `pending-baseline` (first approval) or `diff`. */
  reviewState: Exclude<ReviewState, "passed">;
}

/** One row in the Runs history — every run, newest first, regardless of outcome. */
export interface RunSummary {
  runId: string;
  testName: string;
  environment: string;
  status: RunStatus;
  runTimestamp: string;
  /** Why a `failed` run failed; null otherwise. */
  error: string | null;
}

/* ─────────────────────────────── Suite runs ─────────────────────────── */

/** Aggregate child-run counts for a suite run — derived on read, never stored. */
export interface SuiteRunCounts {
  total: number;
  queued: number;
  running: number;
  passed: number;
  needsReview: number;
  failed: number;
}

/** One row in the suite-runs history: a fan-out's parent (suite × env(s)). */
export interface SuiteRunSummary {
  suiteRunId: string;
  /** Trigger-time snapshot, so the report survives suite deletion/rename. */
  suiteName: string;
  /** Distinct environment names the fan-out targeted ("default" when none). */
  environments: string[];
  /** Derived from children: all-queued→queued; any queued/running→running; else
   *  failed > needs_review > passed. */
  status: string;
  counts: SuiteRunCounts;
  runTimestamp: string;
}

/** One child inside a suite-run report — an ordinary run, opened via `?run=`. */
export interface SuiteRunChild {
  runId: string;
  testName: string;
  environment: string;
  status: string;
  error: string | null;
}

/** The suite-run report: the aggregate plus children in stable test×env order. */
export interface SuiteRunView extends SuiteRunSummary {
  children: SuiteRunChild[];
}

/* ──────────────────── Tuning (mask / threshold in the viewer) ────────── */

/** Candidate masks/threshold a reviewer is previewing (re-evaluate) or committing
 *  (persist). Both optional so the same shape serves masks and threshold tuning. */
export interface TuningInput {
  masks?: Rect[];
  threshold?: number;
}

/** Result of a re-evaluate (preview) — diff recomputed with candidate masks/threshold
 *  against the STORED baseline+actual; no new capture, mutates nothing. */
export interface ReEvaluation {
  verdict: "match" | "diff";
  /** Mismatched-pixel ratio in [0,1]. */
  diffScore: number;
  threshold: number;
  /** Transient diff image as a data URL; not persisted. */
  diffImage: string | null;
}

/** Result of persisting masks/threshold: the checkpoint was re-judged and a new
 *  test_version written. */
export interface PersistResult {
  reviewState: ReviewState;
  diffScore: number;
  threshold: number;
  /** Version number of the newly written test_version. */
  version: number;
}

/* ────────────────────────── Request bodies ──────────────────────────── */

/** PATCH /tests/:id — organization metadata only (never the definition). */
export interface UpdateTestBody {
  name?: string;
  /** null unfiles the test. */
  folderId?: string | null;
  /** Full-list replace. */
  tags?: string[];
}

/** POST /environments. */
export interface CreateEnvironmentBody {
  name: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
}

/** PUT /environments/:id — `values` REPLACES the whole map; secrets are a write-only
 *  delta (`secrets` sets, `removeSecrets` clears). Omitted fields are untouched. */
export interface UpdateEnvironmentBody {
  name?: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
  removeSecrets?: string[];
}

export type DecisionAction = "approve" | "reject";

/* ──────────────────────────── Endpoint map ──────────────────────────── */

/**
 * Machine-readable endpoint surface. Keys are `"<METHOD> <path>"` (path params as
 * `:name`); values declare the JSON request body (when any) and the response shape.
 * Base URL is same-origin (""), overridable via VITE_API_BASE. Lists polled by the
 * UI every ~3s (runs, needs-review, suite-runs) are marked `polled: true`.
 */
export interface Endpoints {
  // Runs & review
  "GET /runs": { polled: true; response: RunSummary[] };
  "GET /runs/needs-review": { polled: true; response: NeedsReviewItem[] };
  "GET /runs/:runId": { response: RunView };
  "POST /runs": {
    body: { testId: string; environmentId?: string; trace?: boolean };
    response: { runId: string };
  };
  "POST /runs/:runId/approve-all": { response: { approved: number } };
  "POST /runs/:runId/checkpoints/:checkpointName/approve": { response: void };
  "POST /runs/:runId/checkpoints/:checkpointName/reject": { response: void };
  "POST /runs/:runId/checkpoints/:checkpointName/re-evaluate": {
    body: TuningInput;
    response: ReEvaluation;
  };
  "POST /runs/:runId/checkpoints/:checkpointName/persist": {
    body: TuningInput;
    response: PersistResult;
  };

  // Tests, folders, tags
  "GET /tests": { response: TestSummary[] };
  "PATCH /tests/:id": { body: UpdateTestBody; response: void };
  "GET /tags": { response: string[] };
  "GET /folders": { response: FolderSummary[] };
  "POST /folders": { body: { name: string }; response: { id: string } };
  "PUT /folders/:id": { body: { name: string }; response: void };
  "DELETE /folders/:id": { response: void };

  // Suites & suite runs
  "GET /suites": { response: SuiteSummary[] };
  "GET /suites/:id": { response: SuiteView };
  "POST /suites": { body: { name: string; testIds?: string[] }; response: { id: string } };
  "PUT /suites/:id": { body: { name?: string; testIds?: string[] }; response: void };
  "DELETE /suites/:id": { response: void };
  "POST /suites/:id/runs": {
    body: { environmentIds: string[]; trace?: boolean };
    response: { suiteRunId: string };
  };
  "GET /suite-runs": { polled: true; response: SuiteRunSummary[] };
  "GET /suite-runs/:id": { polled: true; response: SuiteRunView };

  // Environments
  "GET /environments": { response: EnvironmentView[] };
  "POST /environments": { body: CreateEnvironmentBody; response: { id: string } };
  "PUT /environments/:id": { body: UpdateEnvironmentBody; response: EnvironmentView };
  "DELETE /environments/:id": { response: void };
}
