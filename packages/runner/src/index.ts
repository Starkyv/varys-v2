import {
  baselines,
  type Db,
  environments,
  runResults,
  runs,
  testVersions,
} from "@varys/db";
import { diffPng } from "@varys/diff-engine";
import { resolve } from "@varys/locator-engine";
import type { Fingerprint, TestDefinition, Wait } from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import { type EnvironmentProfile, resolveDefinition } from "@varys/variable-resolver";
import { and, eq } from "drizzle-orm";
import { chromium, type Locator, type Page } from "playwright";

export interface ReplayDeps {
  db: Db;
  storage: StorageAdapter;
}

const DEFAULT_THRESHOLD = 0.01;

function viewportKey(vp: TestDefinition["viewport"]): string {
  return `${vp.width}x${vp.height}@${vp.deviceScaleFactor}`;
}

/** Best-effort single locator from a fingerprint, for wait conditions. */
function waitLocator(page: Page, fp: Fingerprint): Locator {
  if (fp.testId) return page.locator(`[data-testid="${fp.testId}"]`);
  if (fp.attributes?.id) return page.locator(`#${fp.attributes.id}`);
  if (fp.text) return page.getByText(fp.text, { exact: true });
  return page.locator(fp.tag);
}

async function applyWaits(page: Page, waits: Wait[] | undefined): Promise<void> {
  for (const w of waits ?? []) {
    if (w.kind === "delay") {
      await page.waitForTimeout(w.ms);
    } else if (w.kind === "networkIdle") {
      await page.waitForLoadState("networkidle", { timeout: w.timeoutMs });
    } else {
      await waitLocator(page, w.target).waitFor({
        state: w.state,
        timeout: w.timeoutMs,
      });
    }
  }
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
    .select({
      testId: testVersions.testId,
      definition: testVersions.definition,
      environmentId: runs.environmentId,
    })
    .from(runs)
    .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row) throw new Error(`Run ${runId} not found`);
  const { testId } = row;
  const recorded = row.definition as TestDefinition;

  // Resolve {{baseUrl}}/{{var}}/{{secret}} against the run's environment (if any).
  // Secrets live only in this transient resolved definition — never persisted.
  let environment = "default";
  let definition = recorded;
  if (row.environmentId) {
    const [env] = await db
      .select({
        name: environments.name,
        values: environments.values,
        secrets: environments.secrets,
      })
      .from(environments)
      .where(eq(environments.id, row.environmentId))
      .limit(1);
    if (!env) throw new Error(`Environment ${row.environmentId} not found`);
    const profile: EnvironmentProfile = {
      values: (env.values ?? {}) as Record<string, string>,
      secrets: (env.secrets ?? {}) as Record<string, string>,
    };
    definition = resolveDefinition(recorded, profile);
    environment = env.name;
  }
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

      await applyWaits(page, step.waitBefore);

      if (step.type === "click" || step.type === "type") {
        const target = await resolve(page, step.target);
        if (!target) throw new Error(`could not locate ${step.type} target`);
        if (step.type === "type") {
          await target.locator.fill(step.value);
        } else {
          await target.locator.click();
        }
        continue;
      }

      // Smart default: settle the network before capturing the checkpoint.
      await page.waitForLoadState("networkidle").catch(() => undefined);

      // Capture by mode (absent ⇒ element, for back-compat). Element resolves the
      // fingerprint locator; full-page captures the scrollable page; region clips a rect.
      let actual: Buffer;
      let healed = false;
      if (step.captureMode === "fullpage") {
        actual = await page.screenshot({ fullPage: true });
      } else if (step.captureMode === "region") {
        if (!step.rect) throw new Error(`region checkpoint "${step.name}" has no rect`);
        actual = await page.screenshot({ clip: step.rect });
      } else {
        if (!step.target) throw new Error(`element checkpoint "${step.name}" has no target`);
        const found = await resolve(page, step.target);
        if (!found) {
          throw new Error(
            `could not locate checkpoint "${step.name}" — no fingerprint signal matched`,
          );
        }
        actual = await found.locator.screenshot();
        healed = found.healed;
      }
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
            eq(baselines.environment, environment),
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
          healed,
        });
        reviewStates.push("pending-baseline");
      } else {
        const baselineBytes = await storage.get(baseline.artifactKey);
        if (!baselineBytes) throw new Error("baseline artifact missing");
        const { verdict, score, diffImage } = diffPng(
          baselineBytes,
          actual,
          threshold,
          step.masks ?? [],
        );

        if (verdict === "match") {
          await db.insert(runResults).values({
            runId,
            checkpointName: step.name,
            reviewState: "passed",
            actualArtifactKey: actualKey,
            baselineArtifactKey: baseline.artifactKey,
            diffScore: score,
            threshold,
            healed,
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
            healed,
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
