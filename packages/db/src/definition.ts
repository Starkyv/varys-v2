/**
 * The ONE place that answers what a test's definition is, and what a Run replayed.
 *
 * Two questions, two answers, and nothing else in the codebase may answer either for itself:
 *
 * - {@link currentDefinition} — *what is this test, right now?* The thing a run replays, the editor
 *   edits, and a repair session writes back to.
 * - {@link replayedDefinition} — *what did THIS run replay?* Evidence of what happened, which has
 *   to keep meaning something after the test moves on. Never treated as the test, never restored
 *   from.
 *
 * Each is a column expression, correlated on `tests` / `runs`, so a caller drops it into the query
 * it already had rather than paying for a second round trip; {@link currentDefinitionOf} is the
 * one-id convenience written over the expression, not a second implementation of the question.
 *
 * Today both are backed by `test_versions`: a test's definition is its highest-numbered row, and a
 * Run's is the row its `test_version_id` points at. That is an implementation detail of THIS FILE.
 * When the version rows go (ADR 0008) these expressions become `tests.definition` and
 * `runs.definition`, and no caller changes.
 */

import { desc, eq, sql, type SQL } from "drizzle-orm";
import { runs, tests, testVersions } from "./schema";
import type { Db } from "./index";

// Correlation targets are written as fully-qualified identifiers rather than as drizzle column
// references: drizzle drops the table prefix from a column when the outer query has only one table
// in it, and a bare `"id"` inside these subqueries would silently bind to `test_versions.id`.
const TESTS_ID = sql`"tests"."id"`;
const RUNS_TEST_VERSION_ID = sql`"runs"."test_version_id"`;

/**
 * A test's current definition, correlated on `tests.id`.
 *
 * Usable in any query whose FROM includes `tests`. Which version counts as current is decided
 * here and nowhere else.
 */
export const currentDefinition: SQL<unknown> = sql`(
  select v.definition from test_versions v
  where v.test_id = ${TESTS_ID}
  order by v.version desc
  limit 1
)`;

/**
 * The definition a Run replayed, correlated on the run row.
 *
 * Usable in any query whose FROM includes `runs`.
 */
export const replayedDefinition: SQL<unknown> = sql`(
  select v.definition from test_versions v where v.id = ${RUNS_TEST_VERSION_ID}
)`;

/**
 * The test a Run belongs to, correlated on the run row.
 *
 * Part of the same answer as {@link replayedDefinition} and moved with it: today the run reaches
 * its test THROUGH the version row it replayed, which is why callers that want nothing but a test
 * id still join `test_versions`. Going through here means those callers do not have to care, and
 * the migration that gives `runs` its own `test_id` flips this line instead of a dozen joins.
 */
export const replayedTestId: SQL<string> = sql<string>`(
  select v.test_id from test_versions v where v.id = ${RUNS_TEST_VERSION_ID}
)`;

/**
 * The revision number of the definition a Run replayed, correlated on the run row.
 *
 * The same vestige as {@link currentVersion}, on the other side: still reported by the repair
 * session tools, so it cannot go before the contract does.
 */
export const replayedVersion: SQL<number> = sql<number>`(
  select v.version from test_versions v where v.id = ${RUNS_TEST_VERSION_ID}
)`;

/**
 * The revision number of a test's current definition, correlated on `tests.id`.
 *
 * A storage detail that still reaches the wire (`GET /tests/:id`, the save contract's
 * `baseVersion`/`version`) and so cannot be dropped ahead of the contract change. It lives beside
 * the definition it numbers, so that nothing outside this file resolves a current version.
 */
export const currentVersion: SQL<number> = sql<number>`(
  select max(v.version) from test_versions v where v.test_id = ${TESTS_ID}
)`;

/**
 * The current version ROW of a test — the write path's handle on the storage, not a reader's.
 *
 * Callers that append or replace a version need the row's identity and its review state, which is
 * knowledge about how definitions are stored rather than about what a test *is*. It lives here so
 * that nothing outside this file resolves a current version; it goes when the version rows do, and
 * readers must use {@link currentDefinition} instead.
 */
export async function currentVersionRow(
  db: Db,
  testId: string,
): Promise<{ id: string; version: number; definition: unknown; reviewState: string } | null> {
  const [row] = await db
    .select({
      id: testVersions.id,
      version: testVersions.version,
      definition: testVersions.definition,
      reviewState: testVersions.reviewState,
    })
    .from(testVersions)
    .where(eq(testVersions.testId, testId))
    .orderBy(desc(testVersions.version))
    .limit(1);
  return row ?? null;
}

/** One test's current definition, or null when the test has none (or does not exist). */
export async function currentDefinitionOf(db: Db, testId: string): Promise<unknown | null> {
  const [row] = await db
    .select({ definition: currentDefinition })
    .from(tests)
    .where(eq(tests.id, testId))
    .limit(1);
  return row?.definition ?? null;
}
