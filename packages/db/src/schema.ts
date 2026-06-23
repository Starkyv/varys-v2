import {
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

/** A flat folder — each test's one browsable home (DESIGN §5; no nesting for MVP).
 *  Organization metadata only: never part of the versioned definition. */
export const folders = pgTable("folders", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type RunStatus =
  | "queued"
  | "running"
  | "passed"
  | "needs_review"
  | "failed";

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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // One result per checkpoint per run — lets the worker upsert so a redelivered run
  // can't accumulate duplicate checkpoints.
  (t) => ({ runCheckpointUq: uniqueIndex("run_results_run_checkpoint_uq").on(t.runId, t.checkpointName) }),
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
  values: jsonb("values").notNull().default({}),
  secrets: jsonb("secrets").notNull().default({}),
  /** Cookies seeded onto the browser context before each run against this env
   *  (array of { name, value, domain?, path? }). Values may carry `{{secret:NAME}}`. */
  cookies: jsonb("cookies").notNull().default([]),
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
  suiteRuns,
  testVersions,
  runs,
  runResults,
  runSteps,
  baselines,
  environments,
  draftPreviews,
  testSchedules,
  appSettings,
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
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE TABLE IF NOT EXISTS suite_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id uuid REFERENCES suites(id) ON DELETE SET NULL,
  suite_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
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
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Bring an existing environments table (created before cookies) up to date.
ALTER TABLE environments ADD COLUMN IF NOT EXISTS cookies jsonb NOT NULL DEFAULT '[]'::jsonb;
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
-- better-auth's schema CLI and made idempotent here (\`IF NOT EXISTS\`) to match the
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
`;
