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

/** Who authored a test: a human extension recording, or Claude via the MCP authoring
 *  layer (Slice 14). */
export type TestOrigin = "human" | "ai";

/** A test's lifecycle: `draft` = an un-promoted AI authoring output (held out of suites
 *  and schedules, surfaced in the review queue); `active` = a normal, runnable test. */
export type TestStatus = "draft" | "active";

/**
 * A test's optional cron schedule (Slice 8 — Scheduling). Operational "when-to-run"
 * metadata, NOT part of the versioned definition: setting it writes no new test_version.
 * A row exists ⇒ the test is scheduled; `enabled` gates firing (pause without losing the
 * cron). Full shape returned by `GET /tests/:id/config`.
 */
export interface TestSchedule {
  /** Standard 5-field cron expression. */
  cron: string;
  /** IANA timezone the cron is evaluated in (e.g. "UTC", "Asia/Kolkata"). */
  timezone: string;
  /** Whether the schedule fires. Disabled keeps the cron but never runs. */
  enabled: boolean;
  /** The environment to run against; null = the default (env-less) baseline. */
  environmentId: string | null;
  /** Resolved environment name for display; null when env-less or since-deleted. */
  environmentName: string | null;
  /** Keep a Playwright trace on each scheduled run (for debuggability). */
  keepTrace: boolean;
  /** Next fire time (ISO), computed from cron+timezone; null when disabled. */
  nextRunAt: string | null;
  /** Last fire time (ISO); null until it has fired (set by the firing tick). */
  lastRunAt: string | null;
  /** The run id of the last fire (open via `?run=`); null until it has fired. */
  lastRunId: string | null;
}

/** Compact schedule badge for the Tests list — enough to render a "scheduled · next run"
 *  indicator without the full schedule. */
export interface TestScheduleSummary {
  enabled: boolean;
  cron: string;
  /** Next fire time (ISO); null when disabled. */
  nextRunAt: string | null;
}

/** The editable fields of a test's schedule, written by the test-detail config and sent
 *  under `schedule` in the structural test update (`PATCH /tests/:id`). `null` clears the
 *  schedule; omitting the field leaves it unchanged. */
export interface TestScheduleInput {
  /** Standard 5-field cron expression (validated server-side; bad cron → 400). */
  cron: string;
  /** IANA timezone; defaults to "UTC". */
  timezone?: string;
  /** Defaults to true. */
  enabled?: boolean;
  /** Environment to run against; null/omitted = default baseline. Unknown id → 404. */
  environmentId?: string | null;
  /** Defaults to false. */
  keepTrace?: boolean;
}

/** A saved test (recording), as listed in the Tests view. */
export interface TestSummary {
  id: string;
  name: string;
  createdAt: string;
  /** Lifecycle state — the Tests view lists only `active`; drafts live in the review queue. */
  status: TestStatus;
  /** Who authored it (a promoted AI test keeps `origin: "ai"`). */
  origin: TestOrigin;
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
  /** The test's cron schedule, or null when unscheduled — drives the Tests-list
   *  "scheduled · next run" indicator (Slice 8). */
  schedule: TestScheduleSummary | null;
}

/**
 * A wait primitive as surfaced for the test-config editor. Mirrors the step schema's
 * wait union (kept here as a pure type, like Rect/CaptureMode, so the SPA needs no
 * step-schema/zod dependency). `delay` and `networkIdle` are authorable in the editor;
 * `selector` is display-only in v1 — shown as a locked row and preserved untouched on
 * save (its target is summarized as `targetLabel`).
 */
export type ConfigWait =
  | { kind: "delay"; ms: number }
  | { kind: "networkIdle"; timeoutMs?: number }
  | { kind: "selector"; state: "visible" | "hidden"; timeoutMs?: number; targetLabel: string };

/** The subset of waits the editor writes back. Selector waits are NOT editable in v1
 *  (the server preserves them), so only the two number-only kinds appear here. */
export type EditableWait =
  | { kind: "delay"; ms: number }
  | { kind: "networkIdle"; timeoutMs?: number };

/** One step as the test-config editor renders it — label + the waits before it, plus
 *  the screenshot-only knobs (threshold). `supportsWaits` is false for navigate. */
export interface TestConfigStep {
  /** 0-based position in the definition's step list — the stable key the patch uses
   *  (steps can be removed via the patch, but never reordered or inserted). */
  index: number;
  type: "navigate" | "click" | "type" | "screenshot";
  /** Human label (same `describeStep` vocabulary as the run timeline). */
  label: string;
  /** False for navigate (no `waitBefore` in the schema); true otherwise. */
  supportsWaits: boolean;
  /** The waits the runner applies before this step (after the test-level defaults). */
  waitBefore: ConfigWait[];
  /** Screenshot-only: the checkpoint name; null for non-screenshot steps. */
  checkpointName: string | null;
  /** Screenshot-only: how it's captured. */
  captureMode: CaptureMode | null;
  /** Screenshot-only: the explicit per-checkpoint threshold, or null when it inherits
   *  the runner default (shown as a placeholder in the editor). */
  threshold: number | null;
}

/** The test-config read-model — the latest version's editable surface (waits +
 *  threshold). Produced by `GET /tests/:id/config`. */
export interface TestConfigView {
  id: string;
  name: string;
  /** The latest version number this config reflects — echoed back as `baseVersion`
   *  in a save so the server can reject a stale edit (optimistic concurrency). */
  version: number;
  /** Test-level default waits applied before every wait-supporting step. */
  defaults: ConfigWait[];
  steps: TestConfigStep[];
  /** The test's cron schedule, or null when unscheduled (Slice 8). Edited in the
   *  test-detail config surface and written back via the structural `PATCH /tests/:id`. */
  schedule: TestSchedule | null;
}

/** A per-step edit in a config patch — keyed by `index`. Omitted fields are left as-is. */
export interface TestConfigStepPatch {
  index: number;
  /** Remove this step from the definition entirely. The entry navigation (index 0) can't
   *  be removed; when set, the step's other patch fields are ignored. */
  remove?: boolean;
  /** Replace this step's authorable (delay/networkIdle) waits; any existing selector
   *  waits are preserved server-side. */
  waitBefore?: EditableWait[];
  /** Screenshot-only: set the per-checkpoint threshold (0..1). */
  threshold?: number;
}

/** The body of `PUT /tests/:id/config`: a targeted patch the server applies onto the
 *  latest definition, writing a new audited test version. */
export interface TestConfigPatch {
  /** The version the edit was based on — the server returns 409 if a newer one exists. */
  baseVersion: number;
  /** Replace the test-level default waits (authorable kinds only). Omit to leave as-is. */
  defaults?: EditableWait[];
  /** Per-step edits. Omit to leave all steps as-is. */
  steps?: TestConfigStepPatch[];
}

/** Result of a config save: the version number of the newly written test_version. */
export interface SaveConfigResult {
  version: number;
}

/**
 * One row in the AI-authored Draft review queue (`GET /drafts`, Slice 14). A draft is a
 * first-class test held out of suites/schedules until a human reviews and promotes it.
 */
export interface DraftSummary {
  id: string;
  name: string;
  origin: TestOrigin;
  createdAt: string;
  /** Number of checkpoints (screenshot steps) the draft asserts — 0 ⇒ flagged (a test
   *  that asserts nothing). */
  checkpointCount: number;
  /** The steering instruction that produced the draft, if any (review-queue context). */
  intent: string | null;
  /** A representative authoring-preview thumbnail (the first checkpoint's screenshot Claude
   *  captured), or null when the draft has no preview. A reference image, NOT the golden
   *  baseline — the pinned runner seeds that on first replay (DESIGN §4). */
  previewUrl: string | null;
}

/** One checkpoint's authoring preview — the reference screenshot Claude captured during
 *  authoring, shown in the promote dialog so the reviewer sees what the test will assert. */
export interface DraftCheckpointPreview {
  name: string;
  captureMode: CaptureMode;
  /** Authenticated artifact-route URL of the preview PNG; null if none was captured. */
  previewUrl: string | null;
}

/** The full Draft detail (`GET /drafts/:id`) — the summary plus every checkpoint's
 *  authoring preview, for a richer pre-promotion view. */
export interface DraftView {
  id: string;
  name: string;
  origin: TestOrigin;
  createdAt: string;
  intent: string | null;
  checkpoints: DraftCheckpointPreview[];
}

/** Body of `POST /drafts/:id/promote` — assign a folder + tags and make the test active
 *  (suite/schedule eligible). Promotion is web-UI only and never an agent tool. */
export interface PromoteDraftBody {
  /** The folder to file the promoted test into; null/omitted leaves it unfiled. */
  folderId?: string | null;
  /** Tags to apply on promotion (full-list replace, normalized). */
  tags?: string[];
}

/**
 * One active Authoring Session, as listed for the live-preview picker
 * (`GET /authoring/sessions`, Slice 15 — Author with AI). An Authoring Session is the live
 * server-side browser Claude drives; this is just enough to identify and choose one to watch.
 */
export interface AuthoringSessionSummary {
  sessionId: string;
  /** The name of the test being authored. */
  name: string;
  /** The steering intent that opened the session, if any. */
  intent: string | null;
  /** The session's current page URL and title. */
  url: string;
  title: string;
  /** Recorded steps and proposed checkpoints so far. */
  stepCount: number;
  checkpointCount: number;
}

/**
 * A live frame of an Authoring Session — a page screenshot captured after a mutating tool
 * (click / type / navigate / checkpoint), streamed to the web live-preview pane
 * (`GET /authoring/sessions/:id/stream`, Slice 15). Decoupled from the model's perception: the
 * agent only "sees" a screenshot when it calls `observe(screenshot:true)`; these frames are a
 * human-only channel and are never sent to the model (so watching costs no inference).
 */
export interface AuthoringFrame {
  sessionId: string;
  /** Monotonic per-session sequence number (ordering / dedup). */
  seq: number;
  url: string;
  title: string;
  /** Page screenshot as a data URL (`data:image/png;base64,…`), ready for an `<img src>`. */
  screenshot: string;
  /** What was just recorded into the test. */
  recorded: { type: string; checkpoint?: string };
  /** Recorded steps and proposed checkpoints after this frame. */
  stepCount: number;
  checkpointCount: number;
}

/**
 * Emitted on the live stream when an Authoring Session finishes and its steps are persisted as a
 * Draft (Slice 15). The web uses it to hand off to the review queue — "Draft created → Review it"
 * — the moment authoring completes.
 */
export interface AuthoringDraftEvent {
  sessionId: string;
  /** The created Draft test id. */
  testId: string;
  version: number;
  checkpointCount: number;
  /** The authored test's name. */
  name: string;
}

/**
 * A Bridge that links a user's local Bridge Helper to their in-product chat (Slice 15 — Author
 * with AI). One bridge = one chat = one Authoring Session. Created by the signed-in web user;
 * the helper claims the short `pairingCode` out-of-band to obtain a chat-scoped token.
 */
export interface BridgeChatState {
  chatId: string;
  /** Short, one-time pairing code shown in the web UI to link the helper; null once the helper
   *  has paired or the code has expired. */
  pairingCode: string | null;
  /** Unix ms when the pairing code expires; null once paired/expired. */
  pairingExpiresAt: number | null;
  /** Whether a Bridge Helper is currently connected to this chat. */
  helperConnected: boolean;
  /** The correlated Authoring Session id (drives the slice-01 live preview); null until the
   *  helper binds one. */
  sessionId: string | null;
}

/** Result of claiming a pairing code (`POST /authoring/bridge/pair`) — returned ONLY to the
 *  helper. `bridgeToken` is a chat-scoped secret the helper presents on its stream/event calls. */
export interface BridgePairResult {
  chatId: string;
  bridgeToken: string;
}

/** An event mirrored into the web chat (server → web). The relay owns `status`; `assistant` and
 *  `tool` are forwarded from the Bridge Helper. */
export type BridgeEvent =
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "status"; helperConnected: boolean; sessionId: string | null };

/** A command the web sends down to the Bridge Helper (server → helper). Prompts only for now;
 *  cancel/interrupt arrive in a later slice. */
export type BridgeCommand = { type: "prompt"; text: string };

/** What the Bridge Helper POSTs up to the relay (helper → server). `assistant`/`tool` are
 *  mirrored to the web verbatim; `session` correlates the Authoring Session and the relay turns
 *  it into a `status` event. */
export type BridgeHelperEvent =
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "session"; sessionId: string };

/**
 * Whether Claude Code is driving the MCP authoring server (Slice 15). The MCP transport is
 * **stateless HTTP** — each tool call is a separate POST with no held connection — so this is an
 * *activity* signal (a request seen within the recent window), not a literal socket state.
 */
export interface McpStatus {
  /** True when an MCP request was seen within the recent-activity window. */
  connected: boolean;
  /** Unix ms of the last MCP request seen this server process, or null if none yet. */
  lastSeenAt: number | null;
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
 * A cookie seeded into the browser context BEFORE a run, so a test that needs an
 * existing session/consent cookie starts with it already set. `value` supports the
 * same `{{var}}` / `{{secret:NAME}}` tokens steps do — keep a real auth token in a
 * write-only secret and reference it here rather than pasting it in plain.
 */
export interface EnvCookie {
  /** Cookie name. */
  name: string;
  /** Cookie value; may contain `{{var}}` / `{{secret:NAME}}` tokens (resolved at run). */
  value: string;
  /** Cookie domain. Defaults to the run's `baseUrl` host when omitted. */
  domain?: string;
  /** Cookie path. Defaults to `/`. */
  path?: string;
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
  /** Cookies seeded onto the browser context before each run against this environment.
   *  Definitions are returned plain; put sensitive values in a secret and reference it
   *  via `{{secret:NAME}}` in the cookie value. */
  cookies: EnvCookie[];
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
  /** Audit trail of the current approved baseline for this checkpoint+environment:
   *  who approved it and when (ISO). Null until a baseline has been approved (Slice 10). */
  baselineApprovedBy: string | null;
  baselineApprovedAt: string | null;
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

/**
 * One EXECUTED step of a run, with timing and outcome — the per-step timeline
 * recorded for every run (traced or not). The skeleton the future custom timeline
 * UI renders; steps never reached are simply absent (derive "didn't run" from the
 * definition's full step list, as the failed-run view already does).
 */
export interface StepRun {
  /** 0-based position in the run's steps. */
  index: number;
  /** Human label (same vocabulary as StepLabel). */
  label: string;
  /** The checkpoint name when this step is a screenshot step; null otherwise.
   *  The join key to the matching CheckpointView. */
  checkpointName: string | null;
  /** When the step started executing, ISO 8601. */
  startedAt: string;
  /** How long the step took, milliseconds (to-failure for the failing step). */
  durationMs: number;
  /** `passed` (completed) | `failed` (the step that threw). */
  outcome: "passed" | "failed";
}

/**
 * A distilled, display-oriented view of the recorded element fingerprint the worker
 * resolves a step against. Surfaced behind the run viewer's on-demand "what the locator
 * was looking for" panel — shown for every step/checkpoint that has a target, so both a
 * clean match and a failed locate are explainable without re-running a trace. A subset
 * of the full step-schema fingerprint — only the human-meaningful signals.
 */
export interface FingerprintSummary {
  /** The element's tag, e.g. `div`, `button`. */
  tag: string;
  /** ARIA role, explicit or implicit; null when none. */
  role: string | null;
  /** The accessible name the matcher recorded; null when the element had none. */
  accessibleName: string | null;
  /** Whether the accessible name came from a stable attribute (aria-label/title) rather
   *  than volatile visible text — a durable-name signal. */
  nameFromAttr: boolean;
  /** Visible text snapshot — may be long or carry volatile data (dates, live numbers);
   *  truncated for display. */
  text: string | null;
  /** `data-testid`, if recorded — the strongest, most durable signal. */
  testId: string | null;
  /** The element's `id` attribute, if any. */
  elementId: string | null;
  /** Other identifying attributes (id excluded — surfaced separately); null when none. */
  attributes: Record<string, string> | null;
  /** Durable (non-build-hashed) classes the matcher prefers; null when none. */
  stableClasses: string[] | null;
  /** All raw classes — includes build-hashed ones that rotate per deploy; null when none. */
  moduleClasses: string[] | null;
  /** Ancestor chain, nearest first, as compact `tag[role]#id` labels; null when none. */
  ancestors: string[] | null;
  /** Recorded position + size in screenshot pixels; null when not captured. */
  boundingBox: Rect | null;
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
  /** The recorded target fingerprint per step, indexed by step position (0-based) — what
   *  the locator was looking for. `null` for steps with no element target (navigate, or a
   *  full-page / region screenshot). Powers the viewer's on-demand "what the locator was
   *  looking for" panel for EVERY step/checkpoint, passed or failed. */
  fingerprints: (FingerprintSummary | null)[];
  /** Artifact URL of the kept Playwright trace zip, or null when the trigger
   *  didn't request one (traces are per-trigger on demand only). */
  traceUrl: string | null;
  /** The per-step execution timeline (every run): one entry per step that ran,
   *  in order. Empty until the run starts executing. */
  timeline: StepRun[];
  checkpoints: CheckpointView[];
}

/**
 * The KPI summary strip on the run dashboard — headline figures, each with a delta
 * against the prior comparable window. Everything is computed server-side (derived
 * on read from runs/run_results/tests); the web layer only formats and labels it,
 * never recomputes. (Slice 7 — Run dashboard.)
 */
export interface DashboardSummary {
  /** Total saved tests (recordings). */
  totalTests: number;
  /** Distinct environments that have at least one run ("across N environments"). */
  environmentsCount: number;
  /** Tests created in the last 7 days (the total-tests delta). */
  totalTestsDelta: number;
  /** Pass rate over the last 7 days: `passed` ÷ finished (`passed`|`needs_review`|
   *  `failed`); `0` when there are no finished runs in the window. */
  passRate: number;
  /** Signed percentage-point change in pass rate vs the prior 7-day window. */
  passRateDeltaPct: number;
  /** Checkpoints currently awaiting a decision (`pending-baseline`|`diff`, unresolved). */
  needsReview: number;
  /** Of those pending checkpoints, how many arrived in the last 7 days. */
  needsReviewDelta: number;
  /** Runs that failed in the last 24 hours. */
  failures24h: number;
  /** Signed change vs the prior 24-hour window (current − prior). */
  failures24hDelta: number;
}

/**
 * A test × environment matrix cell's derived status. `none` = the pairing has never
 * run. Otherwise the latest run for that pairing, mapped: failed/running/passed
 * directly, and a `needs_review` run split into `needs_review` (a diff to judge) vs
 * `pending-baseline` (a first capture to approve) by its checkpoints.
 */
export type MatrixCellStatus =
  | "passed"
  | "needs_review"
  | "pending-baseline"
  | "failed"
  | "running"
  | "none";

/** One cell of the dashboard matrix: the latest run's status for a (test, env). */
export interface MatrixCell {
  /** Environment name this cell is for (matches a `DashboardMatrix.environments` entry). */
  environment: string;
  status: MatrixCellStatus;
  /** The latest run to open on click; null when the pairing has never run (`none`). */
  runId: string | null;
}

/** One matrix row: a test and its per-environment cells (aligned to the column order). */
export interface MatrixRow {
  testId: string;
  testName: string;
  /** One cell per environment, in `DashboardMatrix.environments` order. */
  cells: MatrixCell[];
}

/**
 * The hero test × environment status matrix — one cell per (test, environment),
 * each the latest run's outcome. Columns are the environments that have any run
 * ("default" for env-less runs); rows are the tests that have any run.
 */
export interface DashboardMatrix {
  /** Column order — environment names that have at least one run. */
  environments: string[];
  rows: MatrixRow[];
}

/**
 * One checkpoint's diff-score trend over the last 14 days — the data behind a
 * dashboard sparkline. The series is the per-run mismatch ratio in run order, so a
 * checkpoint drifting toward its threshold stands out before it fails.
 */
export interface CheckpointTrend {
  checkpointName: string;
  /** The owning test (the same checkpoint name can exist in different tests). */
  testName: string;
  /** Diff scores (mismatch ratio in [0,1]) over the last 14 days, oldest→newest. */
  points: number[];
  /** The most recent diff score in the series. */
  latestScore: number;
  /** Severity band of the latest score (danger ≥ 5%, warning ≥ 1%, else success). */
  tone: "success" | "warning" | "danger";
}

/**
 * The run dashboard read-model — assembled derive-on-read from runs/run_results/
 * tests/environments (no stored aggregate, no new table): the KPI summary, the test
 * × environment status matrix, the recent-runs activity feed, and the per-checkpoint
 * diff-trend sparklines.
 */
export interface DashboardView {
  summary: DashboardSummary;
  matrix: DashboardMatrix;
  /** Newest standalone runs (suite-run children excluded, as in the Runs history). */
  recentRuns: RunSummary[];
  /** The most-relevant checkpoint diff trends (worst latest score first). */
  trends: CheckpointTrend[];
}
