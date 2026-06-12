import { type Db, runResults, runs, testVersions } from "@varys/db";
import type { TestDefinition } from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import { eq } from "drizzle-orm";
import { chromium } from "playwright";

export interface ReplayDeps {
  db: Db;
  storage: StorageAdapter;
}

/**
 * Replay a run server-side: launch pinned chromium, walk the recorded steps,
 * screenshot each checkpoint element, store the image via the storage adapter,
 * and record a run_result. Determinism: fixed viewport/DPR, reduced motion.
 *
 * TB3 (walking skeleton): plain selector, no baseline/diff yet — that's TB2 of
 * the *next* slice. Errors mark the run failed and rethrow (so the queue can
 * apply its retry policy later).
 */
export async function processRun(deps: ReplayDeps, runId: string): Promise<void> {
  const { db, storage } = deps;

  await db
    .update(runs)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(runs.id, runId));

  const [row] = await db
    .select({ definition: testVersions.definition })
    .from(runs)
    .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row) throw new Error(`Run ${runId} not found`);
  const definition = row.definition as TestDefinition;

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: {
        width: definition.viewport.width,
        height: definition.viewport.height,
      },
      deviceScaleFactor: definition.viewport.deviceScaleFactor,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();

    for (const step of definition.steps) {
      if (step.type === "navigate") {
        await page.goto(step.url, { waitUntil: "networkidle" });
      } else {
        const bytes = await page.locator(step.selector).screenshot();
        const key = `runs/${runId}/${step.name}.png`;
        await storage.put(key, bytes);
        await db.insert(runResults).values({
          runId,
          checkpointName: step.name,
          status: "passed",
          artifactKey: key,
        });
      }
    }

    await context.close();
    await db
      .update(runs)
      .set({ status: "passed", updatedAt: new Date() })
      .where(eq(runs.id, runId));
  } catch (err) {
    await db
      .update(runs)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(runs.id, runId));
    throw err;
  } finally {
    await browser.close();
  }
}
