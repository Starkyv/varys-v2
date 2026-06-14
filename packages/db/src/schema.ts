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
`;
