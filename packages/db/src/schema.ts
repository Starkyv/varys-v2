import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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

export const runResults = pgTable("run_results", {
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
});

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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const schema = {
  folders,
  tests,
  testTags,
  suites,
  suiteTests,
  testVersions,
  runs,
  runResults,
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
`;
