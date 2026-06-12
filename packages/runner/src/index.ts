import { baselines, type Db, runResults, runs, testVersions } from "@varys/db";
import { diffPng } from "@varys/diff-engine";
import type { TestDefinition } from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import { and, eq } from "drizzle-orm";
import { chromium } from "playwright";

export interface ReplayDeps {
  db: Db;
  storage: StorageAdapter;
}

const DEFAULT_THRESHOLD = 0.01;
/** Real per-environment runs arrive in MVP Issue 4; until then, one default. */
const ENVIRONMENT = "default";

function viewportKey(vp: TestDefinition["viewport"]): string {
  return `${vp.width}x${vp.height}@${vp.deviceScaleFactor}`;
}

/**
 * Replay a run server-side: launch pinned chromium, walk the recorded steps,
 * and for each screenshot checkpoint either seed a pending baseline (no prior
 * baseline) or diff against the active baseline. Determinism: fixed
 * viewport/DPR, reduced motion. Errors mark the run failed and rethrow.
 */
export async function processRun(deps: ReplayDeps, runId: string): Promise<void> {
  const { db, storage } = deps;

  await db
    .update(runs)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(runs.id, runId));

  const [row] = await db
    .select({ testId: testVersions.testId, definition: testVersions.definition })
    .from(runs)
    .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row) throw new Error(`Run ${runId} not found`);
  const { testId } = row;
  const definition = row.definition as TestDefinition;
  const vpKey = viewportKey(definition.viewport);

  const browser = await chromium.launch();
  const reviewStates: string[] = [];
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
        continue;
      }

      const actual = await page.locator(step.selector).screenshot();
      const actualKey = `runs/${runId}/${step.name}.png`;
      await storage.put(actualKey, actual);
      const threshold = step.threshold ?? DEFAULT_THRESHOLD;

      const [baseline] = await db
        .select({ artifactKey: baselines.artifactKey })
        .from(baselines)
        .where(
          and(
            eq(baselines.testId, testId),
            eq(baselines.checkpointName, step.name),
            eq(baselines.environment, ENVIRONMENT),
            eq(baselines.viewportKey, vpKey),
          ),
        )
        .limit(1);

      if (!baseline) {
        // Seed: nothing to compare against yet — awaits first approval.
        await db.insert(runResults).values({
          runId,
          checkpointName: step.name,
          reviewState: "pending-baseline",
          actualArtifactKey: actualKey,
          threshold,
          healed: false,
        });
        reviewStates.push("pending-baseline");
      } else {
        const baselineBytes = await storage.get(baseline.artifactKey);
        if (!baselineBytes) throw new Error("baseline artifact missing");
        const { verdict, score, diffImage } = diffPng(baselineBytes, actual, threshold);

        if (verdict === "match") {
          await db.insert(runResults).values({
            runId,
            checkpointName: step.name,
            reviewState: "passed",
            actualArtifactKey: actualKey,
            baselineArtifactKey: baseline.artifactKey,
            diffScore: score,
            threshold,
            healed: false,
          });
          reviewStates.push("passed");
        } else {
          const diffKey = `runs/${runId}/${step.name}.diff.png`;
          await storage.put(diffKey, diffImage);
          await db.insert(runResults).values({
            runId,
            checkpointName: step.name,
            reviewState: "diff",
            actualArtifactKey: actualKey,
            baselineArtifactKey: baseline.artifactKey,
            diffArtifactKey: diffKey,
            diffScore: score,
            threshold,
            healed: false,
          });
          reviewStates.push("diff");
        }
      }
    }

    await context.close();
    const status = reviewStates.some((s) => s !== "passed")
      ? "needs_review"
      : "passed";
    await db
      .update(runs)
      .set({ status, updatedAt: new Date() })
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
