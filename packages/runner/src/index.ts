import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baselines,
  type Db,
  environments,
  runResults,
  runs,
  runSteps,
  testVersions,
} from "@varys/db";
import { diffPng } from "@varys/diff-engine";
import { resolve } from "@varys/locator-engine";
import { describeStep, type Fingerprint, type TestDefinition, type Wait } from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import {
  type EnvironmentProfile,
  resolveStep,
  resolveString,
  resolveWaits,
} from "@varys/variable-resolver";
import { and, eq, sql } from "drizzle-orm";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright";

export interface ReplayDeps {
  db: Db;
  storage: StorageAdapter;
}

const DEFAULT_THRESHOLD = 0.01;

/** A cookie seeded onto the browser context before a run (env-scoped). Mirrors
 *  `EnvCookie` in @varys/review-contract; inlined to avoid a runner→contract dep. */
type EnvCookie = { name: string; value: string; domain?: string; path?: string };

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

/** Upsert config so a re-executed run (e.g. a redelivered job) overwrites its prior
 *  checkpoint row rather than inserting a duplicate — conflict target is the unique
 *  index on (run_id, checkpoint_name). The human `resolution` and original `created_at`
 *  are deliberately left untouched. */
const RESULT_CONFLICT = {
  target: [runResults.runId, runResults.checkpointName],
  set: {
    reviewState: sql`excluded.review_state`,
    actualArtifactKey: sql`excluded.actual_artifact_key`,
    baselineArtifactKey: sql`excluded.baseline_artifact_key`,
    diffArtifactKey: sql`excluded.diff_artifact_key`,
    diffScore: sql`excluded.diff_score`,
    threshold: sql`excluded.threshold`,
    healed: sql`excluded.healed`,
  },
};

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
      trace: runs.trace,
    })
    .from(runs)
    .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row) throw new Error(`Run ${runId} not found`);
  const { testId } = row;
  const recorded = row.definition as TestDefinition;

  const reviewStates: string[] = [];
  // Which step is currently executing — read by the catch so the failure names it.
  // Null before the loop / after it completes (so pre- and post-loop errors aren't
  // misattributed to a step).
  let failedStepIndex: number | null = null;
  let failedStepLabel = "";
  // The per-step timeline (every run): accumulated as steps complete, plus the
  // failing step in the catch, then persisted once in `finally`. The current
  // step's checkpoint name + start are hoisted so the catch can time the failure.
  const stepRuns: (typeof runSteps.$inferInsert)[] = [];
  let currentCheckpointName: string | null = null;
  let stepStartedAt: Date | null = null;
  let stepStartMs = 0;
  const recordStep = (outcome: "passed" | "failed"): void => {
    if (failedStepIndex == null || stepStartedAt == null) return;
    stepRuns.push({
      runId,
      stepIndex: failedStepIndex,
      label: failedStepLabel,
      checkpointName: currentCheckpointName,
      startedAt: stepStartedAt,
      durationMs: Date.now() - stepStartMs,
      outcome,
    });
  };
  let browser: Browser | undefined;
  // Context + tracing live at function scope so the trace is stopped, uploaded,
  // and persisted in `finally` — covering the success AND failure paths uniformly,
  // with the context still open when tracing stops.
  let context: BrowserContext | undefined;
  let tracingStarted = false;
  try {
    // Load the run's environment profile (if any). Resolution happens PER STEP in the
    // loop below — so an unresolved token (e.g. "{{baseUrl}}") is attributed to the
    // exact step that uses it. Secrets live only in the transient resolved step and are
    // never persisted.
    let environment = "default";
    let profile: EnvironmentProfile | null = null;
    let envCookies: EnvCookie[] = [];
    if (row.environmentId) {
      const [env] = await db
        .select({
          name: environments.name,
          values: environments.values,
          secrets: environments.secrets,
          cookies: environments.cookies,
        })
        .from(environments)
        .where(eq(environments.id, row.environmentId))
        .limit(1);
      if (!env) throw new Error(`Environment ${row.environmentId} not found`);
      profile = {
        values: (env.values ?? {}) as Record<string, string>,
        secrets: (env.secrets ?? {}) as Record<string, string>,
      };
      environment = env.name;
      envCookies = (env.cookies ?? []) as EnvCookie[];
    }
    const vpKey = viewportKey(recorded.viewport);

    browser = await chromium.launch();
    context = await browser.newContext({
      viewport: {
        width: recorded.viewport.width,
        height: recorded.viewport.height,
      },
      deviceScaleFactor: recorded.viewport.deviceScaleFactor,
      reducedMotion: "reduce",
    });
    // Trace only when the trigger asked for it (on-demand only — no automatic
    // capture). Screenshots + DOM snapshots make the hosted Trace Viewer useful.
    if (row.trace) {
      await context.tracing.start({ screenshots: true, snapshots: true });
      tracingStarted = true;
    }

    // Seed the environment's cookies onto the context BEFORE any navigation, so a test
    // that needs an existing session/consent cookie starts with it already set. Values
    // resolve the same {{var}}/{{secret:NAME}} tokens steps do (keep real auth tokens in
    // a write-only secret and reference them). Domain falls back to the run's baseUrl.
    if (envCookies.length > 0) {
      const baseUrl = profile?.values.baseUrl;
      const toSet = envCookies.map((c) => {
        const value = profile ? resolveString(c.value, profile) : c.value;
        const cookie: { name: string; value: string; url?: string; domain?: string; path?: string } = {
          name: c.name,
          value,
        };
        if (c.domain) {
          cookie.domain = c.domain;
          cookie.path = c.path ?? "/";
        } else if (baseUrl) {
          cookie.url = baseUrl;
        } else {
          throw new Error(`cookie "${c.name}" needs a domain (the environment has no baseUrl to derive one)`);
        }
        return cookie;
      });
      await context.addCookies(toSet);
    }

    const page = await context.newPage();

    // Test-level default waits — applied before EVERY step that supports waits, ahead
    // of the step's own `waitBefore` (a global "settle the network before each
    // checkpoint" lives here, per-step waits layer on top). Resolved once like a step's
    // waits so a tokenized selector-wait default resolves against the environment.
    const defaultWaits = recorded.defaults?.waitBefore ?? [];
    const resolvedDefaultWaits = profile ? resolveWaits(defaultWaits, profile) : defaultWaits;

    for (let i = 0; i < recorded.steps.length; i++) {
      const raw = recorded.steps[i];
      // Optimistically blame this step; the catch reads these if anything throws
      // (resolution OR execution). Cleared after the loop. The same fields time
      // this step for the run_steps timeline (recorded on completion / in catch).
      failedStepIndex = i;
      failedStepLabel = describeStep(raw);
      currentCheckpointName = raw.type === "screenshot" ? raw.name : null;
      stepStartedAt = new Date();
      stepStartMs = Date.now();
      // Resolve this step's tokens now — an unresolved {{token}} fails THIS step.
      const step = profile ? resolveStep(raw, profile) : raw;
      if (step.type === "navigate") {
        await page.goto(step.url, { waitUntil: "networkidle" });
        recordStep("passed");
        continue;
      }

      await applyWaits(page, [...resolvedDefaultWaits, ...(step.waitBefore ?? [])]);

      if (step.type === "click" || step.type === "type") {
        // A prior click may have triggered a navigation (e.g. an OAuth login redirect)
        // that is still in flight — the recorder no longer emits explicit navigate steps
        // for redirects, so settle the document before resolving the target, or the
        // fingerprint would miss against a half-loaded page. Cheap when already loaded.
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        const target = await resolve(page, step.target);
        if (!target) throw new Error(`could not locate ${step.type} target`);
        if (step.type === "type") {
          await target.locator.fill(step.value);
        } else {
          await target.locator.click();
        }
        recordStep("passed");
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
        if (found) {
          actual = await found.locator.screenshot();
          healed = found.healed;
        } else {
          // The scored matcher couldn't confidently resolve. For a screenshot a wrong
          // region is far cheaper than a wrong click, so fall back to the recorded
          // deterministic CSS path (first match) when one exists, and mark it healed.
          // (Clicks deliberately have no such fallback.)
          const cssPath = step.target.cssPath;
          let fallbackShot: Buffer | null = null;
          if (cssPath) {
            try {
              const loc = page.locator(cssPath).first();
              if ((await loc.count()) > 0) fallbackShot = await loc.screenshot();
            } catch {
              fallbackShot = null; // malformed selector → treat as no fallback
            }
          }
          if (!fallbackShot) {
            throw new Error(
              `could not locate checkpoint "${step.name}" — no fingerprint signal matched`,
            );
          }
          actual = fallbackShot;
          healed = true;
        }
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
        await db
          .insert(runResults)
          .values({
            runId,
            checkpointName: step.name,
            reviewState: "pending-baseline",
            actualArtifactKey: actualKey,
            threshold,
            healed,
          })
          .onConflictDoUpdate(RESULT_CONFLICT);
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
          await db
            .insert(runResults)
            .values({
              runId,
              checkpointName: step.name,
              reviewState: "passed",
              actualArtifactKey: actualKey,
              baselineArtifactKey: baseline.artifactKey,
              diffScore: score,
              threshold,
              healed,
            })
            .onConflictDoUpdate(RESULT_CONFLICT);
          reviewStates.push("passed");
        } else {
          const diffKey = `runs/${runId}/${step.name}.diff.png`;
          await storage.put(diffKey, diffImage);
          await db
            .insert(runResults)
            .values({
              runId,
              checkpointName: step.name,
              reviewState: "diff",
              actualArtifactKey: actualKey,
              baselineArtifactKey: baseline.artifactKey,
              diffArtifactKey: diffKey,
              diffScore: score,
              threshold,
              healed,
            })
            .onConflictDoUpdate(RESULT_CONFLICT);
          reviewStates.push("diff");
        }
      }
      // Checkpoint captured + judged — record the (screenshot) step.
      recordStep("passed");
    }
    // Every step ran — a later error (close / status write) is not a step failure.
    failedStepIndex = null;
    failedStepLabel = "";

    // Context is closed in `finally` (after the trace is stopped, if any).
    const status = reviewStates.some((s) => s !== "passed")
      ? "needs_review"
      : "passed";
    await db
      .update(runs)
      .set({ status, updatedAt: new Date() })
      .where(eq(runs.id, runId));
  } catch (err) {
    // Persist why it failed so the viewer can show it. A failed run captures no
    // checkpoints, so this message + the failed step index are all the reviewer has —
    // prefix the step ("Step 2/5 — click "Submit": …") when a step was running.
    const base = err instanceof Error ? err.message : String(err);
    const message = (
      failedStepIndex != null
        ? `Step ${failedStepIndex + 1}/${recorded.steps.length} — ${failedStepLabel}: ${base}`
        : base
    ).slice(0, 2000);
    // Record the failing step in the timeline (with its duration-to-failure).
    recordStep("failed");
    // A replay that reaches a verdict — a step threw, a locator missed, a diff over
    // threshold — is a COMPLETED job whose run is terminally "failed", NOT a queue-level
    // error. Record the verdict and return normally so pg-boss acks the job. Rethrowing
    // would make the queue treat a normal failed run as a job failure and re-execute it,
    // re-running the whole replay and (pre-idempotency) duplicating run_steps/run_results.
    // Only an inability to record the verdict (e.g. the DB is unreachable) propagates, so
    // the job can legitimately retry.
    try {
      await db
        .update(runs)
        .set({ status: "failed", error: message, failedStepIndex, updatedAt: new Date() })
        .where(eq(runs.id, runId));
    } catch (finalizeErr) {
      // eslint-disable-next-line no-console
      console.error(`[runner] could not finalize run ${runId} as failed:`, finalizeErr);
      throw finalizeErr;
    }
  } finally {
    // Persist the per-step timeline (every run). Best-effort — a valuable record,
    // but not worth masking the run outcome or crashing the worker.
    if (stepRuns.length > 0) {
      try {
        await db
          .insert(runSteps)
          .values(stepRuns)
          .onConflictDoUpdate({
            target: [runSteps.runId, runSteps.stepIndex],
            set: {
              label: sql`excluded.label`,
              checkpointName: sql`excluded.checkpoint_name`,
              startedAt: sql`excluded.started_at`,
              durationMs: sql`excluded.duration_ms`,
              outcome: sql`excluded.outcome`,
            },
          });
      } catch (stepErr) {
        // eslint-disable-next-line no-console
        console.error(`[runner] step timeline persist failed for run ${runId}:`, stepErr);
      }
    }
    // Stop + store the trace on BOTH paths, while the context is still open. The
    // trigger explicitly asked for it, so it's kept on every outcome (incl.
    // failure, where it's most useful). Best-effort: a trace stop/upload/persist
    // failure must never mask the replay outcome already recorded above.
    if (tracingStarted && context) {
      let traceDir: string | undefined;
      try {
        traceDir = await mkdtemp(join(tmpdir(), "varys-trace-"));
        const zipPath = join(traceDir, "trace.zip");
        await context.tracing.stop({ path: zipPath });
        const traceKey = `runs/${runId}/trace.zip`;
        await storage.put(traceKey, await readFile(zipPath));
        await db
          .update(runs)
          .set({ traceArtifactKey: traceKey, updatedAt: new Date() })
          .where(eq(runs.id, runId));
      } catch (traceErr) {
        // eslint-disable-next-line no-console
        console.error(`[runner] trace capture failed for run ${runId}:`, traceErr);
      } finally {
        if (traceDir) await rm(traceDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    await context?.close();
    await browser?.close();
  }
}
