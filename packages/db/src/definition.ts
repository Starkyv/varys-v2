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
 * Both resolve to the columns that hold the answer (ADR 0008): a test's definition is
 * `tests.definition`, a Run's is its own write-once `runs.definition`. `test_versions` is gone —
 * dropped, not merely unread — so these two expressions are the whole of it. There is no third
 * question, because there is no history to ask one about.
 */

import { eq, sql, type SQL } from "drizzle-orm";
import { tests } from "./schema";
import type { Db } from "./index";

// Written as fully-qualified identifiers rather than as drizzle column references so that an
// expression stays bound to the table it names even in a query that joins `tests` and `runs` —
// both of which have a `definition` column, and a bare `"definition"` would be ambiguous.

/**
 * A test's current definition, correlated on `tests.id`.
 *
 * Usable in any query whose FROM includes `tests`. A test has exactly one, so "current" is now a
 * word about time rather than about which row wins.
 */
export const currentDefinition: SQL<unknown> = sql`"tests"."definition"`;

/**
 * The definition a Run replayed, correlated on the run row.
 *
 * Usable in any query whose FROM includes `runs`. The Run's OWN copy, taken when it launched —
 * which is the whole point: it still describes what happened after the test is edited.
 */
export const replayedDefinition: SQL<unknown> = sql`"runs"."definition"`;

/**
 * The test a Run belongs to, correlated on the run row.
 *
 * Part of the same answer as {@link replayedDefinition}: a Run reaches its test directly.
 */
export const replayedTestId: SQL<string> = sql<string>`"runs"."test_id"`;

/** One test's current definition, or null when the test has none (or does not exist). */
export async function currentDefinitionOf(db: Db, testId: string): Promise<unknown | null> {
  const [row] = await db
    .select({ definition: currentDefinition })
    .from(tests)
    .where(eq(tests.id, testId))
    .limit(1);
  return row?.definition ?? null;
}
