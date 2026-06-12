import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const tests = pgTable("tests", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const testVersions = pgTable("test_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  testId: uuid("test_id")
    .notNull()
    .references(() => tests.id),
  version: integer("version").notNull(),
  definition: jsonb("definition").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** A run status. Issue 1/2 subset: baseline/diff/heal statuses arrive later. */
export type RunStatus = "queued" | "running" | "passed" | "failed";

export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  testVersionId: uuid("test_version_id")
    .notNull()
    .references(() => testVersions.id),
  status: text("status").notNull().default("queued"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const runResults = pgTable("run_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id),
  checkpointName: text("checkpoint_name").notNull(),
  status: text("status").notNull(),
  artifactKey: text("artifact_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const schema = { tests, testVersions, runs, runResults };

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
CREATE TABLE IF NOT EXISTS test_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES tests(id),
  version integer NOT NULL,
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_version_id uuid NOT NULL REFERENCES test_versions(id),
  status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS run_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id),
  checkpoint_name text NOT NULL,
  status text NOT NULL,
  artifact_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
