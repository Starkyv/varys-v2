import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** A folder — each test's one browsable home (DESIGN §5). Folders nest via `parentId`
 *  (null = a root folder); names are unique among siblings. Deleting a folder deletes its whole
 *  subtree of folders (ON DELETE CASCADE), but the TESTS in them are only unfiled, never deleted
 *  (tests.folder_id is SET NULL). Organization metadata only: never part of the versioned
 *  definition. */
export const folders = pgTable("folders", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** Parent folder, or null for a root folder. Self-FK; ON DELETE CASCADE removes the subtree. */
  parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tests = pgTable("tests", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** The test's folder; null = Unfiled. Folder deletion unfiles (SET NULL). */
  folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
  /** Lifecycle: `draft` = an un-promoted AI authoring output, held out of suites and
   *  schedules and surfaced in the review queue; `active` = a normal test. Human
   *  recordings are `active` on create — the draft gate is AI-only (Slice 14). */
  status: text("status").notNull().default("active"),
  /** Author: `human` (extension recording) or `ai` (Claude via the MCP authoring layer). */
  origin: text("origin").notNull().default("human"),
  /** The steering instruction that produced an AI draft (review-queue context); null otherwise. */
  intent: text("intent"),
  /** Who created the test — the uploader's email for a human (extension) recording, or
   *  "ai" for an AI-authored draft. Audit pair with createdAt. Null for rows created
   *  before this column existed. */
  createdBy: text("created_by"),
  /** Who promoted an AI draft into the active corpus, and when — the one human gate on
   *  AI output (ADR 0001). Null for human recordings and un-promoted drafts. */
  promotedBy: text("promoted_by"),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  /** Optional free-form note on the test (organization/annotation only — never part of
   *  the versioned definition). Edited inline on the test-detail page. */
  notes: text("notes"),
  /** Which kind of test this is. `pinned` — the only kind before Agent-Driven Tests — is
   *  behaviour written down as data: ordered steps, each carrying a Fingerprint, replayed by the
   *  worker with no model call. `agent` is an **Agent-Driven Test**: no steps and no fingerprints,
   *  an ordered list of `agent_checkpoints` that a locally-run Claude re-walks every Run. Defaults
   *  to `pinned`, so every test recorded before this column is exactly what it was. */
  kind: text("kind").notNull().default("pinned"),
  /** How long an Agent Run Session on this test may run before Varys closes it, in seconds
   *  (Agent-Driven Tests). The bound on an agent that will not stop: retrying is deliberately the
   *  agent's own business, but an agent retrying a state that will NEVER appear has no reason to
   *  stop, and it is the author's own Claude subscription it is burning. Wall-clock rather than a
   *  tool-call budget, because twenty cheap actions and twenty expensive ones cost wildly
   *  different amounts. Defaulted for every existing and new row, so nothing is unbounded, and
   *  meaningless for a pinned test — which Varys runs itself and bounds by its own timeouts. */
  agentLeaseSeconds: integer("agent_lease_seconds").notNull().default(900),
  /**
   * **The test's definition** — the one answer to "what is this test?" (ADR 0008).
   *
   * Written beside the version row today and read by nobody: `test_versions` stays authoritative
   * for reads until the ticket that drops it, at which point {@link currentDefinition} resolves
   * here instead and every reader follows without changing. Nullable only so the column can be
   * added to a live table; after the bootstrap backfill every pinned test carries one.
   */
  definition: jsonb("definition"),
  /**
   * Who last changed the definition, and when — the attribution that survives the history.
   *
   * With one definition per test there is no row to read "who wrote this" off, so the pair lives
   * on the test itself. `updatedAt` doubles as the stale-editor token the config save compares
   * against, in place of a version number.
   */
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Free-form tags on tests (many-to-many slicing, DESIGN §5 — `release:5.0` style
 *  namespacing is convention, not schema). Composite PK = a tag attaches at most
 *  once per test. Organization metadata only — never part of the definition. */
export const testTags = pgTable(
  "test_tags",
  {
    testId: uuid("test_id")
      .notNull()
      .references(() => tests.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.testId, t.tag] }) }),
);

/** A suite — a named, saved selection of tests: THE run unit (DESIGN §5). Slice 6
 *  executes `suite × env(s)`; this slice only defines and manages them. */
export const suites = pgTable("suites", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** Who created the suite (email). Null for rows created before this column existed. */
  createdBy: text("created_by"),
  /**
   * The suite's AI Instructions — the OUTERMOST of the three layers composed for an Agent Run
   * Session (suite, then test, then the checkpoint's own), concatenated and never overridden.
   *
   * Lives on the suite rather than being retyped into every test because it is shared context:
   * which app, which account, which standing exceptions. It applies only to Agent-Driven members
   * — a pinned test is replayed with no model call and has nothing to read it.
   */
  agentInstructions: text("agent_instructions"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Suite membership (explicit, many-to-many — a test may be in several suites).
 *  CASCADE both ways: deleting a suite removes memberships only, never tests. */
export const suiteTests = pgTable(
  "suite_tests",
  {
    suiteId: uuid("suite_id")
      .notNull()
      .references(() => suites.id, { onDelete: "cascade" }),
    testId: uuid("test_id")
      .notNull()
      .references(() => tests.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.suiteId, t.testId] }) }),
);

/** Suite folder membership — a suite can include whole folders (all tests in the folder AND its
 *  subfolders), resolved DYNAMICALLY at read/run time so a test added to the folder later is
 *  included automatically. A suite's effective tests = these folders' tests ∪ `suiteTests`
 *  (individually-picked standalone tests), deduped. CASCADE both ways (memberships only). */
export const suiteFolders = pgTable(
  "suite_folders",
  {
    suiteId: uuid("suite_id")
      .notNull()
      .references(() => suites.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.suiteId, t.folderId] }) }),
);

/** A suite run — the parent of a fan-out: one ordinary child run per
 *  (member test × environment), DESIGN §6. No aggregate state is stored —
 *  status/counts are derived on read from the children. The suite FK is
 *  SET NULL + a name snapshot so reports survive suite deletion/rename. */
export const suiteRuns = pgTable("suite_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  suiteId: uuid("suite_id").references(() => suites.id, { onDelete: "set null" }),
  /** Trigger-time snapshot of the suite's name. */
  suiteName: text("suite_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  /** When the one-shot Slack completion notification was claimed+sent (fan-in). NULL until the
   *  LAST child finishes and one worker atomically claims it — so a suite notifies exactly once. */
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
});

export const testVersions = pgTable("test_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  testId: uuid("test_id")
    .notNull()
    .references(() => tests.id),
  version: integer("version").notNull(),
  definition: jsonb("definition").notNull(),
  /** Who authored this version (e.g. "system" for an in-viewer mask/threshold
   *  persist). Audit pair with createdAt. Null for the original recording. */
  createdBy: text("created_by"),
  /**
   * Whether this version has been reviewed by a human (Slice 19, slice 04).
   *
   * `reviewed` for everything a person wrote — which, with repair attended, is every version.
   * `rejected` records a version a reviewer threw away; the test was reverted by appending the
   * previous definition as a new version, so the history keeps the rejected attempt rather than
   * erasing it.
   */
  reviewState: text("review_state").notNull().default("reviewed"),
  /** Who accepted or rejected this version, and when. Both null while it is `unreviewed`, and
   *  for every version that never needed reviewing. */
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type RunStatus =
  | "queued"
  | "running"
  | "passed"
  | "needs_review"
  | "failed"
  | "cancelled"; // stopped before finishing (e.g. its test was deleted mid-run)

export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  testVersionId: uuid("test_version_id")
    .notNull()
    .references(() => testVersions.id),
  environmentId: uuid("environment_id"),
  /** The fan-out parent when this run is a suite-run child; null = standalone. */
  suiteRunId: uuid("suite_run_id").references(() => suiteRuns.id),
  /** Whether the trigger asked for a Playwright trace. On-demand ONLY — there is
   *  no automatic keep on failure/seed (decided deviation from DESIGN §9). */
  trace: boolean("trace").notNull().default(false),
  /** Where the kept trace zip lives; null = none requested (or capture failed). */
  traceArtifactKey: text("trace_artifact_key"),
  status: text("status").notNull().default("queued"),
  /** Why a `failed` run failed (the replay error) — null otherwise. */
  error: text("error"),
  /** What CLASS of failure ended the run, when it is classified (Slice 19):
   *  `locator` | `pixel` | `judge` | `assertion` | `timeout` | `crash`. Plain reporting: it tells
   *  whoever opens the red run what kind of thing broke before they decide whether to open a
   *  Repair Session. Null for runs that are not red and for runs that finished before this column
   *  existed. Recorded rather than inferred from the error text, so it cannot rot when a message
   *  is reworded. */
  failureKind: text("failure_kind"),
  /** 0-based index of the step that failed (null when it failed before any step). */
  failedStepIndex: integer("failed_step_index"),
  /** Who triggered the run (email), or "ai"/sentinel for non-human triggers. A suite
   *  child carries the suite-launcher's email; a scheduled fire (when wired) carries the
   *  schedule owner. Null for runs created before this column existed. */
  triggeredBy: text("triggered_by"),
  /** How the run was triggered: `manual` | `suite` | `schedule` | `api` | `repair` | `varys`.
   *  Pairs with triggeredBy so "ran by the cron owner" is distinguishable from a manual run.
   *  `varys` marks an Agent Run Session that answered a Run Request pressed in the web app —
   *  evidence for a reader only; nothing branches on it. Nullable, and stays so: absence means
   *  "not known", which is the honest reading for every run predating each of these values. */
  triggerSource: text("trigger_source"),
  /** Optional free-form note on the run (annotation only). Edited inline on the run-detail page. */
  notes: text("notes"),
  /**
   * The fully composed AI Instructions this Agent Run Session was handed, copied VERBATIM at
   * session start (Agent-Driven Tests). Null for every pinned run.
   *
   * A copy rather than a reference, and that is the whole point of the column: instructions and
   * checkpoints are deliberately unversioned, so without it a run from six weeks ago becomes
   * unexplainable the moment any of its layers is reworded. This is the compensating control for
   * that choice — the only record of what the agent was actually told.
   */
  agentInstructions: text("agent_instructions"),
  /**
   * The agent's own written account of the session, stored when it finishes the run
   * (Agent-Driven Tests). Null for every pinned run, and null on an agent run nobody ever
   * finished — which is exactly what distinguishes "the session ended and said this" from "the
   * session stopped and never said anything".
   *
   * Doubles as the CLOSED flag: a run with a summary accepts no further submissions, so an agent
   * cannot declare itself done and then keep revising what it reported.
   */
  agentSummary: text("agent_summary"),
  /**
   * The wall-clock lease this session was GRANTED, in seconds — copied off the test at start
   * (Agent-Driven Tests). Null for every pinned run, and for an agent run that predates leases.
   *
   * A copy for the same reason `agent_instructions` is one: the test's lease is editable and
   * unversioned, so without it "was this run given ten minutes or ten hours?" becomes
   * unanswerable the moment someone changes the setting.
   */
  agentLeaseSeconds: integer("agent_lease_seconds"),
  /**
   * When that lease runs out — an ABSOLUTE deadline, computed once when the session starts.
   *
   * This is the enforced value, not `agent_lease_seconds`: stamping the instant means the bound
   * cannot drift with the run row's other timestamps, and expiry is a comparison against the wall
   * clock rather than arithmetic over two clocks that may not agree. Past it, the session is
   * closed and every tool that would write to it is refused. Nothing sweeps it — the run has been
   * `failed`/`unreached` since its rows were seeded, so expiry needs no reconciliation to be
   * correctly red.
   */
  agentLeaseExpiresAt: timestamp("agent_lease_expires_at", { withTimezone: true }),
  /**
   * The test this Run belongs to — reached DIRECTLY rather than through the version row it
   * replayed (ADR 0008). Written beside `test_version_id` today and read by nobody until
   * {@link replayedTestId} resolves here. Nullable only so the column can be added to a live
   * table; after the bootstrap backfill every run carries one.
   */
  testId: uuid("test_id").references(() => tests.id),
  /**
   * **What this Run replayed** — a write-once copy of the definition as it read at launch.
   *
   * A copy for the same reason `agent_instructions` is one: the test moves on, and a timeline, a
   * failed step index or a repair drive all stop meaning anything if they are read against
   * today's steps. Read only by this Run's own surfaces, never treated as the test, and never
   * restored from.
   */
  definition: jsonb("definition"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Per-checkpoint review state. Mirrors `@varys/review-contract`'s `ReviewState` — `missing` is a
 *  Checkpoint Manifest slot pre-seeded before an agent starts and never filled. */
export type ReviewState = "pending-baseline" | "diff" | "passed" | "missing";
export type Resolution = "approved" | "rejected";

export const runResults = pgTable(
  "run_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    checkpointName: text("checkpoint_name").notNull(),
    reviewState: text("review_state").notNull(),
    actualArtifactKey: text("actual_artifact_key"),
    baselineArtifactKey: text("baseline_artifact_key"),
    diffArtifactKey: text("diff_artifact_key"),
    diffScore: doublePrecision("diff_score"),
    threshold: doublePrecision("threshold").notNull(),
    healed: boolean("healed").notNull().default(false),
    resolution: text("resolution"),
    /** Who recorded the approve/reject decision (email) and when — the audit pair for
     *  `resolution`. Null while the checkpoint is still unresolved. */
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** The LLM judge's one-line rationale for a `context`-compared checkpoint (shown to the
     *  reviewer beside the two images). Null for pixel-compared checkpoints. */
    judgeReasoning: text("judge_reasoning"),
    /**
     * How the ACTUAL capture was produced, when an Agent-Driven Test's agent said so — the tool
     * it used, the viewport it captured at, and the device scale factor. Null for every pinned
     * run, where Varys performed the capture itself and the answer is never in doubt.
     *
     * **Evidence, not a constraint.** Varys hosts no browser for this kind (ADR 0007) and cannot
     * verify any of it, so nothing here is enforced and nothing is compared against it. Its whole
     * job is to let a reviewer staring at a baffling comparison ask the first useful question —
     * were these two pictures even taken the same way? — instead of guessing. A baseline shot
     * headless at 1280×800 and an actual shot via computer use on a Retina display are genuinely
     * different pictures, and this is where that shows.
     */
    captureTool: text("capture_tool"),
    captureViewport: text("capture_viewport"),
    captureDeviceScale: doublePrecision("capture_device_scale"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // One result per checkpoint per run — lets the worker upsert so a redelivered run
  // can't accumulate duplicate checkpoints.
  (t) => ({ runCheckpointUq: uniqueIndex("run_results_run_checkpoint_uq").on(t.runId, t.checkpointName) }),
);

/**
 * An extra screenshot an agent attached to a run — UNNAMED, unlimited, and keying no baseline
 * (Agent-Driven Tests).
 *
 * The deliberate opposite of a `run_results` row: that one is a Checkpoint Manifest slot, and its
 * name is the closed set the Manifest exists to enforce. This one is "here is what the page looked
 * like when I could not find the filter" — material a reviewer diagnosing a red run actually
 * wants, and which nothing about the Manifest requires forbidding. Being nameless is what keeps
 * the two apart: evidence can never be mistaken for a slot, promoted to a baseline, or counted
 * toward what the run verified.
 */
export const runEvidence = pgTable(
  "run_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    artifactKey: text("artifact_key").notNull(),
    /** The agent's caption — why it thought this was worth keeping. Empty when it said nothing. */
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // Read per run in attachment order — the sequence is the story, so it is the only access pattern.
  (t) => ({ runEvidenceRunIdx: index("run_evidence_run_idx").on(t.runId, t.createdAt) }),
);

/**
 * Per-assertion run result (Slice 19, slice 09) — one row per DECLARED, pinned assertion of the
 * definition this run replayed. Run OUTPUT, like run_results: relational, never part of the
 * versioned definition.
 *
 * `assertionId` is the author-chosen id from the definition, which is what makes an assertion's
 * history a straight query: the id survives an edit to its `check` text, so the row written last
 * night and the row written tonight belong to the same line on the chart even after the wording
 * changed. `checkText` is snapshotted per run for exactly the same reason — the history has to be
 * able to say what the check SAID when it ran.
 */
export const runAssertions = pgTable(
  "run_assertions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    /** The definition's stable, author-chosen assertion id. */
    assertionId: text("assertion_id").notNull(),
    /** The plain-language check AS IT READ on this run (the definition's may have changed since). */
    checkText: text("check_text").notNull(),
    /**
     * `passed` | `relation-false` | `extraction-failed` | `judge-failed` | `judge-unavailable`.
     *
     * These are deliberately separate values rather than one `failed`: `relation-false` means both
     * values were read and they disagree (the APP is wrong), `extraction-failed` means a side
     * produced no value at all (the TEST is wrong — a locator missed). Slice 10 wires the
     * consequence off this column, so collapsing them would erase the distinction the assertion
     * story rests on.
     *
     * The last two are the judge fallback (slice 11): `judge-failed` is the model answering no,
     * and `judge-unavailable` is NO ANSWER AT ALL — the run made no claim either way, which is why
     * it is neither a pass nor a failure and marks the run needs-review instead.
     */
    outcome: text("outcome").notNull(),
    /**
     * `pinned` | `judged` — how this verdict was reached (slice 11). Recorded per run rather than
     * read off today's definition, because an assertion that gets pinned next week must not
     * retroactively claim its old approximate verdicts were exact.
     */
    mode: text("mode").notNull().default("pinned"),
    /** The judge's one-line rationale for a `judged` verdict. Null for every pinned one. */
    reasoning: text("reasoning"),
    /** Why extraction failed — `unresolved` (a locator problem) | `coercion` (a definition
     *  problem). Null for every other outcome. */
    cause: text("cause"),
    /**
     * Which side's target failed to extract — `left` | `right`. Null for every other outcome.
     *
     * Persisted rather than re-derived, because it is what the repair path re-pins (slice 10): the
     * cluster key of an assertion's locator failure comes from THAT side's fingerprint, and a side
     * recovered by guessing would scatter one broken locator across two clusters.
     */
    side: text("side"),
    /** The two coerced values compared, rendered for display. Null for a side that produced none. */
    leftValue: text("left_value"),
    rightValue: text("right_value"),
    /** The engine's one-line explanation — what was compared and what happened. */
    detail: text("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // One row per assertion per run — lets the worker upsert so a redelivered run can't accumulate
  // the same assertion twice (and so the history query needs no de-duplication).
  (t) => ({
    runAssertionUq: uniqueIndex("run_assertions_run_assertion_uq").on(t.runId, t.assertionId),
  }),
);

/**
 * Per-step run timeline — one row per EXECUTED step of a run (every run, traced
 * or not). The data skeleton the future custom timeline UI renders: index +
 * label (the `describeStep` vocabulary) + timing + outcome, with `checkpointName`
 * the join point to run_results for screenshot steps. Steps never reached have
 * no row (so "didn't run" stays derivable from the definition's full step list).
 * Run OUTPUT — relational, never part of the versioned definition.
 */
export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    stepIndex: integer("step_index").notNull(),
    label: text("label").notNull(),
    /** The checkpoint (screenshot) name when this step is a checkpoint; null otherwise. */
    checkpointName: text("checkpoint_name"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    /** `passed` (step completed) | `failed` (the step that threw). */
    outcome: text("outcome").notNull(),
  },
  // One row per step per run — lets the worker upsert so a redelivered run can't
  // accumulate the same step multiple times.
  (t) => ({ runStepUq: uniqueIndex("run_steps_run_step_uq").on(t.runId, t.stepIndex) }),
);

/**
 * The API traffic a run saw, attributed to the step that was executing when the request STARTED.
 *
 * Why this exists: a failure whose real cause is the backend reads, on the run, as a locator
 * failure. `failureKind` is decided by the exception's TYPE — a `LocatorUnresolvedError` — and the
 * matcher cannot tell "the button was renamed" from "the button never rendered because
 * /api/orders returned 500". Both arrive as `locator`. These rows are the evidence that
 * distinguishes them, so whoever opens the run reads the cause rather than inferring one.
 *
 * Deliberately NOT a full network log. Only `xhr` / `fetch` / `document` requests are candidates,
 * and of those a run keeps every PROBLEM (a transport failure, a status >= 400, or a request the
 * server never answered) plus the slowest handful of successes — see `selectNetworkEvents` in
 * @varys/runner for the bounds. A heavy SPA fires hundreds of requests per step; keeping them all
 * would cost more than it explains.
 *
 * A Playwright trace holds strictly more than this, but it is captured on demand only
 * (`runs.trace` defaults to false), so it is absent on exactly the runs that need explaining —
 * and a zip is not something the UI or an agent can read. These rows are always there.
 */
export const runNetwork = pgTable(
  "run_network",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    /** 0-based index of the step in flight when the request STARTED, or null when it started
     *  outside any step (context setup, or after the last step finished). Attribution is by
     *  START, not completion: a request that begins in step 3 and fails during step 4 is
     *  step 3's request, and reading it the other way hides the cause one step too late. */
    stepIndex: integer("step_index"),
    method: text("method").notNull(),
    /** Truncated to 2000 chars, like `runs.error`. Query strings are kept — a 500 on
     *  `/api/orders?status=open` is a different fact from a 500 on `/api/orders`. */
    url: text("url").notNull(),
    /** Playwright's `resourceType()`: `xhr` | `fetch` | `document`. */
    resourceType: text("resource_type").notNull(),
    /** HTTP status, or null when no response ever arrived (a transport failure, or a request
     *  still unanswered when the run ended — the API-timeout case this table exists for). */
    status: integer("status"),
    /** Chromium's error text (`net::ERR_TIMED_OUT`, `net::ERR_CONNECTION_REFUSED`), or the
     *  in-flight marker for a request the server never answered. Null when the request
     *  completed, whatever its status. */
    failureText: text("failure_text"),
    /** Wall-clock duration to completion (or to the end of the run, for an unanswered one). */
    durationMs: integer("duration_ms").notNull(),
    /** Time to first byte, from Playwright's resource timing; null when unavailable. Separating
     *  it from `durationMs` is what distinguishes a slow SERVER from a large response. */
    ttfbMs: integer("ttfb_ms"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  },
  // Read per run, ordered by start — the only access pattern the UI and the API have.
  (t) => ({ runNetworkRunIdx: index("run_network_run_idx").on(t.runId, t.startedAt) }),
);

/** The current active baseline per (test, checkpoint, environment, viewport). */
export const baselines = pgTable("baselines", {
  id: uuid("id").defaultRandom().primaryKey(),
  testId: uuid("test_id")
    .notNull()
    .references(() => tests.id),
  checkpointName: text("checkpoint_name").notNull(),
  environment: text("environment").notNull().default("default"),
  viewportKey: text("viewport_key").notNull(),
  artifactKey: text("artifact_key").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * One Checkpoint of an **Agent-Driven Test** — a row of the Checkpoint Manifest.
 *
 * Unlike a pinned test's checkpoint (a screenshot step inside the versioned definition), this is
 * relational and UNVERSIONED: editing the wording of an instruction is not an audit event, so
 * these rows are edited in place and never write a `test_version`.
 *
 * `id` is the row's durable identity and `name` is only its label. That split is what lets a
 * rename carry its approved baselines: `baselines` is keyed by `checkpoint_name`, so renaming
 * updates those rows rather than orphaning them, and renaming for clarity costs nothing.
 */
export const agentCheckpoints = pgTable("agent_checkpoints", {
  id: uuid("id").defaultRandom().primaryKey(),
  testId: uuid("test_id")
    .notNull()
    .references(() => tests.id, { onDelete: "cascade" }),
  /** Order within the journey. The rows are CUMULATIVE — row 3's instructions assume rows 1-2
   *  already happened — so this is the sequence an Agent Run Session walks, not a display hint. */
  position: integer("position").notNull(),
  /** The slot name. Keys a baseline per environment, and is the only name an agent may submit
   *  under. Unique per test — enforced by an index, not by the writing code path. */
  name: text("name").notNull(),
  /** How to reach this state from the previous checkpoint (the increment only). */
  instructions: text("instructions").notNull().default(""),
  /** What must be true in this screenshot for it to match its baseline. Empty falls back to the
   *  configured global default judge prompt. */
  comparePrompt: text("compare_prompt").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** An environment to run against. Secret values are plaintext for the MVP
 *  (local/single-tenant) but must never be returned by the API. */
export const environments = pgTable("environments", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** The base URL the test's `{{baseUrl}}` resolves to for this environment. */
  baseUrl: text("base_url").notNull().default(""),
  /** Cookies seeded onto the browser context before each run against this env
   *  (array of { name, value, domain?, path? }). */
  cookies: jsonb("cookies").notNull().default([]),
  /** localStorage entries seeded into the browser before each run against this env
   *  (array of { key, value, origin? }). */
  localStorage: jsonb("local_storage").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Per-checkpoint REFERENCE screenshots captured during AI authoring (Slice 14) — the
 * "what Claude saw" previews shown in the review queue and promote dialog. NOT golden
 * baselines (recording ≠ baseline, DESIGN §4): the pinned runner still seeds the real
 * baseline on first replay. One row per (test, checkpoint); the PNG lives in storage.
 */
export const draftPreviews = pgTable(
  "draft_previews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    testId: uuid("test_id")
      .notNull()
      .references(() => tests.id, { onDelete: "cascade" }),
    checkpointName: text("checkpoint_name").notNull(),
    artifactKey: text("artifact_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uq: uniqueIndex("draft_previews_test_checkpoint_uq").on(t.testId, t.checkpointName) }),
);

/**
 * A test's optional cron schedule (Slice 8 — Scheduling). Operational "when-to-run"
 * metadata, NOT part of the versioned definition (like `tests.folder_id`/`status`): a
 * 1:1 row per test, set via the structural test update, never bumping a test_version.
 * The firing tick (PRD 1, Issue 2) sweeps `next_run_at <= now()`; `enabled` gates firing
 * (pause without losing the cron). The env pin drops to the default baseline on env
 * deletion (SET NULL); the row dies with its test (CASCADE).
 */
export const testSchedules = pgTable("test_schedules", {
  testId: uuid("test_id")
    .primaryKey()
    .references(() => tests.id, { onDelete: "cascade" }),
  /** Standard 5-field cron expression, evaluated in `timezone`. */
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  /** Disabled keeps the cron but never fires. */
  enabled: boolean("enabled").notNull().default(true),
  /** Environment to run against; null = the default (env-less) baseline. */
  environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "set null" }),
  keepTrace: boolean("keep_trace").notNull().default(false),
  /** Next fire time, computed from cron+timezone on save and after each fire — the
   *  tick's due-key. Null when disabled (nothing to fire). */
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  /** The run id of the last fire (open via ?run=); SET NULL if that run is purged. */
  lastRunId: uuid("last_run_id").references(() => runs.id, { onDelete: "set null" }),
  /** Who set the schedule — the actor attributed to its unattended runs (§11 audit). */
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A suite's optional cron schedule (1:1 with a suite) — the suite analog of `test_schedules`.
 * When it fires, the firing tick triggers a normal suite run (fan-out to the suite's effective
 * tests) against the pinned environment. Dies with its suite (CASCADE); the env pin drops to the
 * default on env deletion (SET NULL); `last_suite_run_id` clears if that suite run is purged.
 */
export const suiteSchedules = pgTable("suite_schedules", {
  suiteId: uuid("suite_id")
    .primaryKey()
    .references(() => suites.id, { onDelete: "cascade" }),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  enabled: boolean("enabled").notNull().default(true),
  /** Environment to run the suite against; null = the default (env-less) baseline. */
  environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "set null" }),
  keepTrace: boolean("keep_trace").notNull().default(false),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  /** The suite_run id of the last fire (open in Suite Runs); SET NULL if that run is purged. */
  lastSuiteRunId: uuid("last_suite_run_id").references(() => suiteRuns.id, { onDelete: "set null" }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Generic key/value store for runtime-editable app settings — config that the team
 * changes from the UI without a redeploy, rather than env vars baked at boot. First user:
 * the AI authoring instructions (the MCP `initialize` prompt), edited on the Author page.
 */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const schema = {
  folders,
  tests,
  testTags,
  suites,
  suiteTests,
  suiteFolders,
  suiteRuns,
  testVersions,
  runs,
  runResults,
  runEvidence,
  runAssertions,
  runSteps,
  runNetwork,
  baselines,
  environments,
  draftPreviews,
  testSchedules,
  appSettings,
  agentCheckpoints,
};

/**
 * Raw DDL applied at bootstrap and in tests — walking-skeleton stand-in for
 * drizzle-kit migrations. Swap to generated migrations once the schema settles.
 */
export const DDL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  parent_id uuid REFERENCES folders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Nested folders: parent_id (null = root). Deleting a folder cascades to its subtree of folders;
-- the tests within are unfiled (tests.folder_id SET NULL), never deleted. Names are unique among
-- SIBLINGS, not globally — drop the old global unique, add a per-parent unique index (nil-uuid
-- stands in for the null parent so root folders are unique among roots).
ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES folders(id) ON DELETE CASCADE;
ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS folders_parent_name_uniq
  ON folders (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
-- Bring an existing tests table up to date; folder deletion unfiles via SET NULL.
ALTER TABLE tests ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;
-- Draft lifecycle (Slice 14 — Claude/MCP authoring): existing rows default to an
-- active human test, so the gate is AI-only and human recordings are untouched.
ALTER TABLE tests ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE tests ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'human';
ALTER TABLE tests ADD COLUMN IF NOT EXISTS intent text;
-- Attribution (Slice A): who created the test, and who promoted an AI draft (+ when).
ALTER TABLE tests ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS promoted_by text;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS promoted_at timestamptz;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS notes text;
-- Test kind (Agent-Driven Tests). 'pinned' = steps + fingerprints the worker replays with no
-- model call (every test that existed before this column); 'agent' = an Agent-Driven Test, whose
-- behaviour is the agent_checkpoints rows below. Defaulted, so nothing already recorded changes.
ALTER TABLE tests ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'pinned';
-- The wall-clock lease an Agent Run Session on this test is bounded by, in seconds. Defaulted for
-- every row that already exists and every row written afterwards, so no test is ever unbounded and
-- nobody has to opt in to being bounded. Fifteen minutes is deliberately modest: it is a stop on an
-- agent grinding at a state that will never appear, not a budget anyone should be spending in full.
ALTER TABLE tests ADD COLUMN IF NOT EXISTS agent_lease_seconds integer NOT NULL DEFAULT 900;
-- One definition per test (ADR 0008). The definition itself, plus who last changed it and when —
-- the attribution that has to survive the version rows, and the token a stale editor is refused
-- against once baseVersion goes. Nullable because the column is added to a live table; the
-- backfill below fills it from each test's highest-numbered version. Dual-written beside
-- test_versions until the reads move over.
ALTER TABLE tests ADD COLUMN IF NOT EXISTS definition jsonb;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE tests ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
-- The ordered Checkpoints of an Agent-Driven Test. Relational and UNVERSIONED: editing the
-- wording of an instruction is not an audit event, so no test_version is written. The row id is
-- the durable identity and the name is only a label, which is what lets a rename carry the
-- approved baselines keyed by checkpoint_name instead of orphaning them.
CREATE TABLE IF NOT EXISTS agent_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  position integer NOT NULL,
  name text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  compare_prompt text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Two checkpoints on one test cannot share a name. In the DATABASE rather than only in the
-- writing code path, because the Checkpoint Manifest's closed-set property depends on it: a
-- duplicate name would make "which baseline does this slot key?" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS agent_checkpoints_test_name_uniq ON agent_checkpoints (test_id, name);
CREATE INDEX IF NOT EXISTS agent_checkpoints_test_position_idx ON agent_checkpoints (test_id, position);
CREATE TABLE IF NOT EXISTS test_tags (
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  tag text NOT NULL,
  PRIMARY KEY (test_id, tag)
);
CREATE TABLE IF NOT EXISTS suites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Attribution (Slice A): who created the suite.
ALTER TABLE suites ADD COLUMN IF NOT EXISTS created_by text;
-- Agent-Driven Tests: the outermost AI Instructions layer, shared across a suite's members.
ALTER TABLE suites ADD COLUMN IF NOT EXISTS agent_instructions text;
CREATE TABLE IF NOT EXISTS suite_tests (
  suite_id uuid NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  PRIMARY KEY (suite_id, test_id)
);
-- Suites can also include whole folders (resolved to their tests + subfolders' tests dynamically).
CREATE TABLE IF NOT EXISTS suite_folders (
  suite_id uuid NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (suite_id, folder_id)
);
CREATE TABLE IF NOT EXISTS suite_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id uuid REFERENCES suites(id) ON DELETE SET NULL,
  suite_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Fan-in Slack notification claim: set once when the last child finishes (exactly-once notify).
ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS notified_at timestamptz;
CREATE TABLE IF NOT EXISTS test_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id),
  version integer NOT NULL,
  definition jsonb NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Bring an existing test_versions table (created before created_by) up to date.
ALTER TABLE test_versions ADD COLUMN IF NOT EXISTS created_by text;
-- Human review of a version (Slice 19, slice 04). Defaults to 'reviewed': with repair attended,
-- every version is written by a person and needs no decision.
ALTER TABLE test_versions ADD COLUMN IF NOT EXISTS review_state text NOT NULL DEFAULT 'reviewed';
ALTER TABLE test_versions ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE test_versions ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
CREATE INDEX IF NOT EXISTS test_versions_unreviewed_idx
  ON test_versions (created_at DESC) WHERE review_state = 'unreviewed';
CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_version_id uuid NOT NULL REFERENCES test_versions(id),
  environment_id uuid,
  status text NOT NULL DEFAULT 'queued',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Bring an existing runs table (created before the error column) up to date.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS failed_step_index integer;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS suite_run_id uuid REFERENCES suite_runs(id);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trace boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trace_artifact_key text;
-- Attribution (Slice A): who triggered the run and how (manual | suite | schedule | api).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS triggered_by text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trigger_source text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS notes text;
-- The fully composed AI Instructions an Agent Run Session was handed, copied verbatim at start
-- (Agent-Driven Tests). Null for every pinned run. It is a COPY because the three instruction
-- layers are unversioned by design: without it, editing a checkpoint's wording would quietly
-- rewrite the history of every run that ever walked it.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS agent_instructions text;
-- The agent's written account of the session, stored when it finishes the run. Also the CLOSED
-- flag: a run carrying one accepts no further submissions, so "done" cannot be walked back.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS agent_summary text;
-- The wall-clock lease this Agent Run Session was granted and when it runs out. The seconds are a
-- forensic copy (the test's setting is editable and unversioned); the timestamp is the enforced
-- deadline, stamped once at start so the bound is absolute. Null for every pinned run.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS agent_lease_seconds integer;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS agent_lease_expires_at timestamptz;
-- Which CLASS of failure ended a failed run (Slice 19): 'locator' = an unresolvable
-- fingerprint (the only repairable class), 'unreached' = an Agent-Driven Test left a Checkpoint
-- Manifest slot unfilled, NULL for everything else. Recorded by the runner, never inferred from
-- the error text. Plain text with no CHECK: the known set is enforced in the API, which degrades
-- an unrecognised value to null rather than shipping a class no surface can render.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS failure_kind text;
-- What this Run replayed, and which test it belongs to (ADR 0008). The definition is a write-once
-- COPY, so a timeline, a failed step index and a repair drive keep meaning something after the
-- test is edited; test_id is the direct link that replaces reaching the test THROUGH the version
-- row. Both nullable because the columns are added to a live table; the backfill below fills them
-- from the version each run actually pointed at.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS test_id uuid REFERENCES tests(id);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS definition jsonb;
-- The backfill. Guarded on definition IS NULL, which is what makes booting twice a no-op: after
-- the first pass every row already carries its copy, and a later save or run writes its own.
-- A test's definition is its HIGHEST-NUMBERED version — the same rule currentDefinition applies.
UPDATE tests t
   SET definition = v.definition,
       updated_by = v.created_by,
       updated_at = v.created_at
  FROM (
    SELECT DISTINCT ON (test_id) test_id, definition, created_by, created_at
      FROM test_versions
     ORDER BY test_id, version DESC
  ) v
 WHERE v.test_id = t.id AND t.definition IS NULL;
-- A Run's copy comes from the version that Run pointed at, NOT from its test's current one: the
-- whole point of the column is that those two can differ.
UPDATE runs r
   SET definition = v.definition,
       test_id = v.test_id
  FROM test_versions v
 WHERE v.id = r.test_version_id AND r.definition IS NULL;
CREATE TABLE IF NOT EXISTS run_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id),
  checkpoint_name text NOT NULL,
  review_state text NOT NULL,
  actual_artifact_key text,
  baseline_artifact_key text,
  diff_artifact_key text,
  diff_score double precision,
  threshold double precision NOT NULL,
  healed boolean NOT NULL DEFAULT false,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Attribution (Slice A): who recorded the approve/reject decision, and when.
ALTER TABLE run_results ADD COLUMN IF NOT EXISTS resolved_by text;
ALTER TABLE run_results ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
-- Dynamic-content testing: the LLM judge's rationale for a context-compared checkpoint.
ALTER TABLE run_results ADD COLUMN IF NOT EXISTS judge_reasoning text;
-- How the ACTUAL capture was produced, when an Agent-Driven Test's agent said so. Evidence, not a
-- constraint: Varys performs no capture for that kind and verifies none of this, so nothing is
-- enforced against it. It exists so a reviewer can ask whether two baffling images were even taken
-- the same way. Null for every pinned run.
ALTER TABLE run_results ADD COLUMN IF NOT EXISTS capture_tool text;
ALTER TABLE run_results ADD COLUMN IF NOT EXISTS capture_viewport text;
ALTER TABLE run_results ADD COLUMN IF NOT EXISTS capture_device_scale double precision;
-- Extra screenshots an agent attached to a run: unnamed, unlimited, keying no baseline. Nameless
-- by design — evidence must never be mistakable for a Manifest slot or promotable to a baseline.
CREATE TABLE IF NOT EXISTS run_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id),
  artifact_key text NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_evidence_run_idx ON run_evidence (run_id, created_at);
CREATE TABLE IF NOT EXISTS run_assertions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id),
  assertion_id text NOT NULL,
  check_text text NOT NULL,
  outcome text NOT NULL,
  cause text,
  left_value text,
  right_value text,
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One row per assertion per run, so a redelivered run upserts instead of accumulating and the
-- per-assertion history needs no de-duplication.
CREATE UNIQUE INDEX IF NOT EXISTS run_assertions_run_assertion_uq ON run_assertions (run_id, assertion_id);
-- Which side's target could not be read (slice 10) — what a repair re-pins. Added after the table,
-- so an install that already has it is unaffected.
ALTER TABLE run_assertions ADD COLUMN IF NOT EXISTS side text;
-- Exact or approximate, and the judge's own words (slice 11). Existing rows default to pinned,
-- which is what they were: the judge fallback did not exist when they were written.
ALTER TABLE run_assertions ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'pinned';
ALTER TABLE run_assertions ADD COLUMN IF NOT EXISTS reasoning text;
CREATE TABLE IF NOT EXISTS run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id),
  step_index integer NOT NULL,
  label text NOT NULL,
  checkpoint_name text,
  started_at timestamptz NOT NULL,
  duration_ms integer NOT NULL,
  outcome text NOT NULL
);
CREATE TABLE IF NOT EXISTS baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id),
  checkpoint_name text NOT NULL,
  environment text NOT NULL DEFAULT 'default',
  viewport_key text NOT NULL,
  artifact_key text NOT NULL,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, checkpoint_name, environment, viewport_key)
);
CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_url text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Bring an existing environments table (created before cookies) up to date.
ALTER TABLE environments ADD COLUMN IF NOT EXISTS cookies jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Bring an existing environments table (created before localStorage) up to date.
ALTER TABLE environments ADD COLUMN IF NOT EXISTS local_storage jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Slim env model: base_url is now a first-class field (was values->>baseUrl); variables +
-- secrets are gone (everything else is a literal on the test). Backfill runs ONLY while the old
-- values column still exists, so this stays idempotent on a fresh or already-migrated DB.
ALTER TABLE environments ADD COLUMN IF NOT EXISTS base_url text NOT NULL DEFAULT '';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'environments' AND column_name = 'values'
  ) THEN
    UPDATE environments SET base_url = COALESCE(values->>'baseUrl', '')
      WHERE base_url = '' AND values ? 'baseUrl';
  END IF;
END $$;
ALTER TABLE environments DROP COLUMN IF EXISTS values;
ALTER TABLE environments DROP COLUMN IF EXISTS secrets;
-- Per-checkpoint authoring preview screenshots (Slice 14 — Claude/MCP authoring).
CREATE TABLE IF NOT EXISTS draft_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  checkpoint_name text NOT NULL,
  artifact_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (test_id, checkpoint_name)
);
-- Per-test cron schedule (Slice 8 — Scheduling). Operational metadata; editing it never
-- writes a test_version. 1:1 with tests (PK = test_id); the env pin drops to the default
-- baseline on env delete (SET NULL); the row dies with its test (CASCADE).
CREATE TABLE IF NOT EXISTS test_schedules (
  test_id uuid PRIMARY KEY REFERENCES tests(id) ON DELETE CASCADE,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  enabled boolean NOT NULL DEFAULT true,
  environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  keep_trace boolean NOT NULL DEFAULT false,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS suite_schedules (
  suite_id uuid PRIMARY KEY REFERENCES suites(id) ON DELETE CASCADE,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  enabled boolean NOT NULL DEFAULT true,
  environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  keep_trace boolean NOT NULL DEFAULT false,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_suite_run_id uuid REFERENCES suite_runs(id) ON DELETE SET NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Idempotency for re-executed runs: first collapse any duplicate rows an earlier
-- redelivered run may have written (keep the latest per group), then enforce one
-- row per (run, step) and (run, checkpoint) so duplicates can't recur. Both the
-- dedup DELETEs and the IF NOT EXISTS index creates are no-ops on later boots.
DELETE FROM run_steps a USING run_steps b
  WHERE a.run_id = b.run_id AND a.step_index = b.step_index
    AND (a.started_at < b.started_at OR (a.started_at = b.started_at AND a.id < b.id));
CREATE UNIQUE INDEX IF NOT EXISTS run_steps_run_step_uq ON run_steps (run_id, step_index);
CREATE TABLE IF NOT EXISTS run_network (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id),
  step_index integer,
  method text NOT NULL,
  url text NOT NULL,
  resource_type text NOT NULL,
  status integer,
  failure_text text,
  duration_ms integer NOT NULL,
  ttfb_ms integer,
  started_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS run_network_run_idx ON run_network (run_id, started_at);
DELETE FROM run_results a USING run_results b
  WHERE a.run_id = b.run_id AND a.checkpoint_name = b.checkpoint_name
    AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));
CREATE UNIQUE INDEX IF NOT EXISTS run_results_run_checkpoint_uq ON run_results (run_id, checkpoint_name);
-- Generic key/value store for runtime-editable app settings (no redeploy). First user:
-- the AI authoring instructions, edited from the Author page.
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- The base authoring prompt moved to authoring_instructions_base_v2 when open_session lost its
-- mode argument. An override stored under the old key would still be teaching Claude to pass an
-- argument the server now refuses, so the orphan is dropped rather than carried: a customised
-- deployment falls back to the new baked-in default, which is the only text that matches the
-- tools. The "additional" layer is untouched — it is team guidance, not the authoring contract.
DELETE FROM app_settings WHERE key = 'authoring_instructions_base';
-- Auth & multi-user (Slice 10 — better-auth-owned tables). These back Varys's OWN
-- user authentication (who can use Varys), distinct from the per-environment
-- app-under-test login vault. better-auth manages these tables itself (via its kysely
-- pg adapter); they are NOT queried through Drizzle, so they have no pgTable object
-- above — only this DDL so they exist at bootstrap. Generated verbatim by
-- better-auth's schema CLI and made idempotent here (\IF NOT EXISTS\) to match the
-- repo's bootstrap-DDL convention. The quoted camelCase identifiers are REQUIRED —
-- better-auth queries them case-sensitively; do not snake_case them.
CREATE TABLE IF NOT EXISTS "user" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "session" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "account" (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS "verification" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");
-- OAuth 2.1 provider tables (Slice 16 — per-user MCP auth). better-auth's "mcp" plugin
-- turns Varys into an OAuth authorization server so each Claude Code client authenticates
-- as a REAL Varys user instead of connecting anonymously: "oauthApplication" holds
-- dynamically-registered MCP clients (DCR — Claude Code registers itself on first
-- connect), "oauthAccessToken" the issued bearer/refresh tokens the /mcp guard resolves
-- to a user, "oauthConsent" a remembered consent grant. Same convention as the tables
-- above: better-auth owns them, quoted camelCase identifiers are REQUIRED.
CREATE TABLE IF NOT EXISTS "oauthApplication" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "icon" text,
  "metadata" text,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "redirectUrls" text NOT NULL,
  "type" text NOT NULL,
  "disabled" boolean NOT NULL DEFAULT false,
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
  "id" text NOT NULL PRIMARY KEY,
  "accessToken" text NOT NULL UNIQUE,
  "refreshToken" text NOT NULL UNIQUE,
  "accessTokenExpiresAt" timestamptz NOT NULL,
  "refreshTokenExpiresAt" timestamptz NOT NULL,
  "clientId" text NOT NULL REFERENCES "oauthApplication" ("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES "user" ("id") ON DELETE CASCADE,
  "scopes" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "oauthConsent" (
  "id" text NOT NULL PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "oauthApplication" ("clientId") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "scopes" text NOT NULL,
  "consentGiven" boolean NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "oauthApplication_userId_idx" ON "oauthApplication" ("userId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" ON "oauthConsent" ("userId");
-- The repair queue is gone (ADR-0008): repair is attended, so nothing enqueues, claims, leases,
-- clusters, triages or suppresses. Dropped rather than left dormant — a table nobody writes is a
-- table the next reader has to reason about. Idempotent, so this runs against a fresh volume and
-- against a database that carried the queue alike. repair_job_tests first: it references
-- repair_jobs. The columns that pointed INTO the queue go with it, for the same reason.
DROP TABLE IF EXISTS repair_job_tests;
DROP TABLE IF EXISTS repair_jobs;
DROP TABLE IF EXISTS suppressed_failures;
ALTER TABLE tests DROP COLUMN IF EXISTS repair_policy;
ALTER TABLE runs DROP COLUMN IF EXISTS triage_finding;
ALTER TABLE runs DROP COLUMN IF EXISTS triage_by;
ALTER TABLE runs DROP COLUMN IF EXISTS triage_at;
ALTER TABLE runs DROP COLUMN IF EXISTS triage_job_id;
ALTER TABLE test_versions DROP COLUMN IF EXISTS repair_job_id;
ALTER TABLE test_versions DROP COLUMN IF EXISTS justification;
ALTER TABLE test_versions DROP COLUMN IF EXISTS justification_reasoning;
ALTER TABLE test_versions DROP COLUMN IF EXISTS justification_validated;
ALTER TABLE test_versions DROP COLUMN IF EXISTS repair_screenshot_key;
-- The circuit-breaker threshold was a project setting; with no breaker it configures nothing.
DELETE FROM app_settings WHERE key = 'repair_breaker_threshold';
-- And the second issuer on /mcp goes with the drainer that needed it (ADR-0008): there is one
-- issuer again, a signed-in human over OAuth, so there is no provisioned token to inventory,
-- rotate or revoke. Dropped rather than kept dormant — a live table of long-lived secrets that
-- nothing accepts any more is worse than no table at all.
DROP TABLE IF EXISTS agent_credentials;
`;
