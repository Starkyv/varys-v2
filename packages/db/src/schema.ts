import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  doublePrecision,
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
  /** Repair Policy (Slice 19): what happens when a run fails on a locator it cannot resolve —
   *  `manual` (surface it; a human opens a Repair Session — today's behaviour) or `auto`
   *  (enqueue a Repair Job). Defaults to `manual` for EVERY test, however it was authored, so
   *  nothing an author recorded starts changing behind their back. Operational metadata, like
   *  `folder_id` / `status`: setting it never writes a test_version. */
  repairPolicy: text("repair_policy").notNull().default("manual"),
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
   * `reviewed` for everything a person wrote — which is every version a human editor or the
   * attended MCP path produces, hence the default. `unreviewed` is written ONLY by an
   * unattended Repair Agent: an AI edit to someone's corpus is never trusted by default, so it
   * sits in the repair review queue until accepted. `rejected` records a version a reviewer
   * threw away; the test was reverted by appending the previous definition as a new version, so
   * the history keeps the rejected attempt rather than erasing it.
   */
  reviewState: text("review_state").notNull().default("reviewed"),
  /** The Repair Job this version was written under, when an agent wrote it — what links a
   *  version awaiting review back to the failure it claims to fix. Plain uuid (no FK) because
   *  the job's table is created after this one in the bootstrap DDL. */
  repairJobId: uuid("repair_job_id"),
  /**
   * The clause of the Brief the repairing agent claimed this version satisfies, and the judge's
   * one-line verdict on that claim (Slice 19, slice 05).
   *
   * Present only on a version an agent wrote and the gate PASSED — a rejected justification never
   * reaches a stored version, because the repair is abandoned and reverted. Shown beside the
   * Brief in review, which is the only way a reviewer can tell what the verdict was checked
   * against.
   */
  justification: text("justification"),
  justificationReasoning: text("justification_reasoning"),
  /**
   * The page the repair was made against, captured live at the instant the fix was written
   * (Slice 19, slice 13) — an artifact key, served through `/artifacts/:token`.
   *
   * The only evidence in a review that is neither the agent's account of itself nor the stored
   * definition: it shows the reviewer the screen the re-pinned control actually lives on, so
   * "same control, renamed" can be confirmed rather than taken on trust. Null for every version
   * written outside a repair session, and for repairs written before this was captured.
   */
  repairScreenshotKey: text("repair_screenshot_key"),
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
   *  `locator` | `pixel` | `judge` | `assertion` | `timeout` | `crash`. `locator` — a fingerprint
   *  the matcher could not resolve — is the only class auto-repair may touch; every other class
   *  gets a read-only Triage Job instead (slice 08). Null for runs that are not red and for runs
   *  that finished before this column existed. Recorded rather than inferred from the error text,
   *  because "is this repairable?" is a safety decision. */
  failureKind: text("failure_kind"),
  /** A Triage Job's written finding on this run (Slice 19, slice 08) — the explanation of a
   *  failure Claude was NOT allowed to fix. An annotation and nothing more: the run's status and
   *  its derived outcome are untouched by it, because a diagnosis must never be mistakable for a
   *  resolution. Null until one is reported. */
  triageFinding: text("triage_finding"),
  /** Who wrote it (a `Repair Agent "…"` label) and when — the audit pair for the finding. */
  triageBy: text("triage_by"),
  triageAt: timestamp("triage_at", { withTimezone: true }),
  /** The Triage Job the finding was reported under, so a finding traces to the claim that made
   *  it. SET NULL is not needed — a job dies with its test, and so does the run. */
  triageJobId: uuid("triage_job_id"),
  /** 0-based index of the step that failed (null when it failed before any step). */
  failedStepIndex: integer("failed_step_index"),
  /** Who triggered the run (email), or "ai"/sentinel for non-human triggers. A suite
   *  child carries the suite-launcher's email; a scheduled fire (when wired) carries the
   *  schedule owner. Null for runs created before this column existed. */
  triggeredBy: text("triggered_by"),
  /** How the run was triggered: `manual` | `suite` | `schedule` | `api`. Pairs with
   *  triggeredBy so "ran by the cron owner" is distinguishable from a manual run. */
  triggerSource: text("trigger_source"),
  /** Optional free-form note on the run (annotation only). Edited inline on the run-detail page. */
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Per-checkpoint review state. Matches the UI read-model literals. */
export type ReviewState = "pending-baseline" | "diff" | "passed";
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // One result per checkpoint per run — lets the worker upsert so a redelivered run
  // can't accumulate duplicate checkpoints.
  (t) => ({ runCheckpointUq: uniqueIndex("run_results_run_checkpoint_uq").on(t.runId, t.checkpointName) }),
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

/** A Repair Job's kind: `repair` may change the test; `triage` (slice 08) only diagnoses. */
export type RepairJobKind = "repair" | "triage";
/** A Repair Job's lifecycle. `queued` is UNCLAIMED — a project with no drainer accumulates
 *  these, which ADR-0003 accepts as long as the queue view makes it visible. */
export type RepairJobStatus = "queued" | "claimed" | "done" | "failed" | "cancelled";

/**
 * The repair queue (Slice 19) — Varys enqueues, a cloud Claude drains (ADR-0003). One row is one
 * request to fix one broken test, created at the point in a run where an unresolvable locator is
 * ALREADY detected (never by a separate scanner), and only when that test's Repair Policy is
 * `auto` — or when a human enqueues it by hand from a failed run.
 *
 * Since slice 07 a job is one request to fix one **Failure Cluster**, which may span many tests:
 * `test_id`/`run_id` are the ANCHOR (the oldest failure, the one a drainer opens its session on)
 * and {@link repairJobTests} carries the full membership. Thirty-eight tests broken by one renamed
 * button are one job, proposed once and applied across the cluster as a single reviewable change.
 *
 * The partial unique index is therefore over `cluster_key` alone WHERE status = 'queued' —
 * project-wide, not per test, which is what makes "one app change, one job" true. It deliberately
 * does not cover finished jobs, so the same break can be re-enqueued after a repair completed or
 * was cancelled.
 */
export const repairJobs = pgTable(
  "repair_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The test to repair. Dies with its test (CASCADE) — a deleted test has nothing to fix. */
    testId: uuid("test_id")
      .notNull()
      .references(() => tests.id, { onDelete: "cascade" }),
    /** The run whose failure created the job. SET NULL so purging a run keeps the job's audit
     *  trail rather than deleting the record of why a test was edited. */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    kind: text("kind").notNull().default("repair"),
    status: text("status").notNull().default("queued"),
    /** Stable identity of the broken locator — `deriveClusterKey` of `@varys/repair-policy`. */
    clusterKey: text("cluster_key").notNull(),
    /** How many times a drainer has attempted this job — the attempt cap's counter (slice 03). */
    attempts: integer("attempts").notNull().default(0),
    /** Who holds the claim (an `agent:…` principal) and since when; both null while queued. */
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** When this claim lapses (slice 03). A Claim is a lease: past this instant the job is
     *  swept back to `queued` with its attempt count incremented, so a drainer that died
     *  mid-repair strands nothing. Null whenever `claimed_by` is. */
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    /** What the drainer said it did when it reported the repair (slice 04) — the account a
     *  reviewer reads beside the version. Null until a repair is reported. */
    report: text("report"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Project-wide: one QUEUED job per broken locator, however many tests it broke (slice 07).
    openUq: uniqueIndex("repair_jobs_cluster_queued_uq")
      .on(t.clusterKey)
      .where(sql`status = 'queued'`),
  }),
);

/**
 * The tests one Repair Job covers — the Failure Cluster's membership (Slice 19, slice 07).
 *
 * A job's `test_id` is only its anchor. This is the list a clustered repair is applied across, a
 * clustered reject reverts, and a Repair Agent credential's reach is scoped to: without it, "the
 * tests covered by a job it has claimed" would be a single test and thirty-seven others would be
 * repaired one divergent proposal at a time.
 *
 * One row per (job, test): a test that keeps failing the same locator while the job is open
 * updates its `run_id` rather than joining twice.
 */
export const repairJobTests = pgTable(
  "repair_job_tests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => repairJobs.id, { onDelete: "cascade" }),
    /** A test in the cluster. Dies with its test — a deleted test is not part of any blast radius. */
    testId: uuid("test_id")
      .notNull()
      .references(() => tests.id, { onDelete: "cascade" }),
    /** The run that surfaced THIS test's failure (each member has its own). SET NULL on purge. */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ memberUq: uniqueIndex("repair_job_tests_uq").on(t.jobId, t.testId) }),
);

/**
 * A locator failure the circuit breaker refused to enqueue (Slice 19, slice 07).
 *
 * When more tests are simultaneously broken than the project's threshold allows, NO jobs are
 * created — mass failure means the app broke or was redesigned, and repairing through it would
 * rewrite the corpus into agreement with a bug. The failures are recorded here instead, which is
 * what makes the suppression visible and what makes the human override possible: releasing a
 * tripped breaker enqueues from these rows, so nothing has to be re-run to recover the work.
 *
 * `target` is the failing fingerprint, stored because the cluster key alone cannot be re-derived
 * and a release must be able to enqueue without the original run.
 */
export const suppressedFailures = pgTable("suppressed_failures", {
  id: uuid("id").defaultRandom().primaryKey(),
  testId: uuid("test_id")
    .notNull()
    .references(() => tests.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  /** Stable identity of the broken locator — the same `deriveClusterKey` the queue uses. */
  clusterKey: text("cluster_key").notNull(),
  /** The recorded fingerprint that missed, so an override can enqueue from this row alone. */
  target: jsonb("target").notNull(),
  /** The threshold in force, and the count that breached it, AT SUPPRESSION TIME — so the record
   *  still explains itself after somebody raises the setting. */
  threshold: integer("threshold").notNull(),
  failingTests: integer("failing_tests").notNull(),
  /** When a human released this for repair (the override). Null while still suppressed. */
  releasedAt: timestamp("released_at", { withTimezone: true }),
  releasedBy: text("released_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A Repair Agent credential (Slice 19, slice 02 — ADR-0005): the long-lived secret an unattended
 * drainer presents on `/mcp` in place of the browser OAuth leg a human completes.
 *
 * The row stores only the SHA-256 of the token — provisioning is the one and only time the secret
 * exists in readable form, so a leaked database yields nothing presentable. `tokenHint` is the
 * token's last four characters, which is what lets an admin tell two credentials apart in the
 * management surface without the secret being recoverable.
 *
 * `expiresAt` is mandatory (ADR-0005 makes expiry load-bearing, not optional), `revokedAt` is the
 * one-click kill switch, and `lastUsedAt` is the only signal an admin has that a credential is
 * still in use — which is why it is written on every successful presentation.
 */
export const agentCredentials = pgTable("agent_credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Human label — also the ATTRIBUTION a repaired version carries (`Repair Agent "<label>"`). */
  label: text("label").notNull(),
  /** SHA-256 hex of the presented token. Unique, and the only stored form of the secret. */
  tokenHash: text("token_hash").notNull().unique(),
  /** Last 4 characters of the token, for recognition in the management surface. */
  tokenHint: text("token_hint").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  /** The admin who provisioned it (email) — provisioning is an audited human act. */
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
  runAssertions,
  runSteps,
  baselines,
  environments,
  draftPreviews,
  testSchedules,
  appSettings,
  repairJobs,
  repairJobTests,
  suppressedFailures,
  agentCredentials,
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
-- Repair Policy (Slice 19). Existing rows default to 'manual' — nothing an author already
-- recorded starts self-editing when this column appears.
ALTER TABLE tests ADD COLUMN IF NOT EXISTS repair_policy text NOT NULL DEFAULT 'manual';
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
-- Human review of a version (Slice 19, slice 04). Defaults to 'reviewed' so every version that
-- already exists — and every version a person writes — needs no decision; only an unattended
-- Repair Agent writes 'unreviewed', which is what puts it in the repair review queue.
ALTER TABLE test_versions ADD COLUMN IF NOT EXISTS review_state text NOT NULL DEFAULT 'reviewed';
ALTER TABLE test_versions ADD COLUMN IF NOT EXISTS repair_job_id uuid;
-- The agent's brief-clause justification and the judge's verdict on it (Slice 19, slice 05).
ALTER TABLE test_versions ADD COLUMN IF NOT EXISTS justification text;
ALTER TABLE test_versions ADD COLUMN IF NOT EXISTS justification_reasoning text;
-- The page a repair was made against, captured live when the fix was written (slice 13).
ALTER TABLE test_versions ADD COLUMN IF NOT EXISTS repair_screenshot_key text;
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
-- Which CLASS of failure ended a failed run (Slice 19): 'locator' = an unresolvable
-- fingerprint (the only repairable class), NULL for everything else. Recorded by the runner,
-- never inferred from the error text.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS failure_kind text;
-- A Triage Job's written finding on a red run (slice 08). An annotation only: the run's status and
-- derived outcome are untouched, because a diagnosis must never be mistakable for a resolution.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS triage_finding text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS triage_by text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS triage_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS triage_job_id uuid;
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
DELETE FROM run_results a USING run_results b
  WHERE a.run_id = b.run_id AND a.checkpoint_name = b.checkpoint_name
    AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));
CREATE UNIQUE INDEX IF NOT EXISTS run_results_run_checkpoint_uq ON run_results (run_id, checkpoint_name);
-- The repair queue (Slice 19). Varys enqueues on an unresolvable-locator failure under
-- an 'auto' Repair Policy; a cloud Claude drains it (ADR-0003). The partial unique index is what
-- makes "one failure, one job" true — ten nightly runs failing the same locator on the same
-- test leave ONE queued job. It covers only queued rows, so the same break can be re-enqueued
-- once a repair finished or was cancelled.
CREATE TABLE IF NOT EXISTS repair_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'repair',
  status text NOT NULL DEFAULT 'queued',
  cluster_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  claimed_by text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repair_jobs_status_idx ON repair_jobs (status, created_at);
-- Clustering (slice 07) moves the "one failure, one job" index from (test_id, cluster_key) to
-- cluster_key alone: a job now covers a whole Failure Cluster, so the same broken locator in a
-- second test JOINS the open job instead of opening a rival one. The old index has to go or it
-- would still admit one queued job per test.
DROP INDEX IF EXISTS repair_jobs_queued_uq;
CREATE UNIQUE INDEX IF NOT EXISTS repair_jobs_cluster_queued_uq
  ON repair_jobs (cluster_key) WHERE status = 'queued';
-- The Failure Cluster's membership: every test one job covers. repair_jobs.test_id is the anchor.
CREATE TABLE IF NOT EXISTS repair_job_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES repair_jobs(id) ON DELETE CASCADE,
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS repair_job_tests_uq ON repair_job_tests (job_id, test_id);
-- Backfill: every pre-clustering job is a cluster of one. Doing it here rather than leaving the
-- readers to fall back to repair_jobs.test_id keeps membership the single source of truth, so no
-- query has to ask "clustered or not?".
INSERT INTO repair_job_tests (job_id, test_id, run_id)
  SELECT id, test_id, run_id FROM repair_jobs
  ON CONFLICT DO NOTHING;
-- Failures the circuit breaker refused to enqueue (slice 07). Recorded rather than dropped: this
-- is what makes a tripped breaker visible, and what the human override enqueues from.
CREATE TABLE IF NOT EXISTS suppressed_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  cluster_key text NOT NULL,
  target jsonb NOT NULL,
  threshold integer NOT NULL,
  failing_tests integer NOT NULL,
  released_at timestamptz,
  released_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suppressed_failures_open_idx
  ON suppressed_failures (created_at) WHERE released_at IS NULL;
-- A Claim is a lease (slice 03): a claimed job carries the instant its claim lapses, after which
-- it is swept back to 'queued' with attempts incremented. Added by ALTER so an existing queue
-- gains the column without the CREATE TABLE above (IF NOT EXISTS) silently skipping it.
ALTER TABLE repair_jobs ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
-- The drainer's account of what it repaired (slice 04), shown beside the unreviewed version.
ALTER TABLE repair_jobs ADD COLUMN IF NOT EXISTS report text;
-- Repair Agent credentials (Slice 19, slice 02 / ADR-0005): the second issuer on /mcp, for an
-- unattended drainer that cannot complete the browser OAuth leg. Only the token's SHA-256 is
-- stored, so the secret is unrecoverable after provisioning; expiry is NOT NULL because ADR-0005
-- treats short expiry, visible last_used_at and one-click revocation as the safeguard.
CREATE TABLE IF NOT EXISTS agent_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_hint text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Generic key/value store for runtime-editable app settings (no redeploy). First user:
-- the AI authoring instructions, edited from the Author page.
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
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
`;
