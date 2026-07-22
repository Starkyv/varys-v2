import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appSettings,
  baselines,
  type Db,
  environments,
  runResults,
  runs,
  runSteps,
  testVersions,
} from "@varys/db";
import { diffPng } from "@varys/diff-engine";
import { resolve, verify } from "@varys/locator-engine";
import {
  describeStep,
  type Fingerprint,
  type Step,
  type TestDefinition,
  type Wait,
} from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import {
  type EnvironmentProfile,
  resolveStep,
  resolveString,
  resolveWaits,
} from "@varys/variable-resolver";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright";

/** Extra Chromium flags from VARYS_BROWSER_ARGS (comma-separated). In containers the
 *  browser runs unprivileged with a small /dev/shm, so set
 *  `--no-sandbox,--disable-dev-shm-usage`. Unset (local/dev) → no extra args. */
export function browserLaunchArgs(): string[] {
  return (process.env.VARYS_BROWSER_ARGS ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

/** How long an action step waits for its target to appear before failing. Content fetched AFTER
 *  navigation (slow SPAs / remote backends) can render several seconds late — the matcher's old
 *  5s poll gave up too early, so a real, soon-to-appear element read as "could not locate".
 *  Playwright's own actionability wait is 30s; we default to a patient 15s, overridable with
 *  `VARYS_ACTION_TIMEOUT_MS` (raise it for a slow backend). A `selector` waitBefore is still the
 *  precise tool when a step needs to gate on a specific element. */
export function actionResolveTimeoutMs(): number {
  const n = Number(process.env.VARYS_ACTION_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

export interface ReplayDeps {
  db: Db;
  storage: StorageAdapter;
}

// Re-exported so callers (e.g. the API's locator-verify probe) can build a profile without
// taking a direct dependency on @varys/variable-resolver.
export type { EnvironmentProfile } from "@varys/variable-resolver";

const DEFAULT_THRESHOLD = 0.01;
/** Default per-pixel colour sensitivity for the diff — mirrors `pixelmatch`'s built-in default
 *  and {@link DEFAULT_PER_PIXEL_THRESHOLD} in @varys/review-contract (inlined to avoid the dep). */
const DEFAULT_PER_PIXEL = 0.1;

/** `app_settings` keys for the global image-comparison defaults, edited on the Configurations page.
 *  Kept in sync with the API's settings service. */
const RATIO_KEY = "image_comparison_ratio";
const PER_PIXEL_KEY = "image_comparison_per_pixel";

/** Read the team's global image-comparison defaults from `app_settings`, falling back to the
 *  built-in defaults when unset or unparseable. A per-checkpoint `step.threshold` still overrides
 *  the ratio; the per-pixel value has no per-checkpoint override and always comes from here. */
async function globalImageDefaults(db: Db): Promise<{ ratio: number; perPixel: number }> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, [RATIO_KEY, PER_PIXEL_KEY]));
  const byKey = new Map(rows.map((r) => [r.key, Number(r.value)]));
  const clamp = (n: number | undefined, fallback: number) =>
    n != null && Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
  return {
    ratio: clamp(byKey.get(RATIO_KEY), DEFAULT_THRESHOLD),
    perPixel: clamp(byKey.get(PER_PIXEL_KEY), DEFAULT_PER_PIXEL),
  };
}

/** A cookie seeded onto the browser context before a run (env-scoped). Mirrors
 *  `EnvCookie` in @varys/review-contract; inlined to avoid a runner→contract dep. */
export type EnvCookie = { name: string; value: string; domain?: string; path?: string };

/** A localStorage entry seeded into the browser before a run (env-scoped). Mirrors
 *  `EnvLocalStorageItem` in @varys/review-contract; inlined to avoid a runner→contract dep. */
export type EnvLocalStorageItem = { key: string; value: string; origin?: string };

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

/**
 * A locator for the nearest stable ancestor of a target (a row / card with a data-testid or id).
 * Used to HOVER that container when the target itself can't be found — many action controls (edit /
 * delete buttons on a card or table row) are hidden with a pure-CSS `:hover` rule (opacity 0 → 1,
 * no DOM change), so the matcher's visibility filter never sees them. Hovering the container reveals
 * the target AND makes it the only visible instance among identical siblings.
 */
function ancestorAnchor(page: Page, fp: Fingerprint): Locator | null {
  for (const a of fp.ancestors ?? []) {
    if (a.testId) return page.locator(`[data-testid="${a.testId}"]`).first();
    if (a.id) return page.locator(`#${a.id}`).first();
  }
  return null;
}

/**
 * Resolve a target; if it isn't found, try revealing it by hovering its nearest stable ancestor
 * (a control that only enters the DOM / becomes `display`-visible on `:hover`, e.g. a JS-rendered
 * flyout), then resolve once more. Returns the matcher result or null.
 */
async function resolveWithHoverReveal(page: Page, fp: Fingerprint, timeoutMs: number) {
  const first = await resolve(page, fp, { timeoutMs });
  if (first) return first;
  const anchor = ancestorAnchor(page, fp);
  if (!anchor) return null;
  await anchor.hover({ timeout: 5_000 }).catch(() => undefined);
  return resolve(page, fp, { timeoutMs: Math.min(timeoutMs, 5_000) });
}

/**
 * Click a resolved target, revealing it first if a pure-CSS `:hover` rule gates its clickability.
 * Card/row edit & delete buttons are commonly `opacity: 0; pointer-events: none` until the card is
 * `:hover`ed. Playwright's click hit-tests the point BEFORE physically hovering, so such a button
 * reads as "intercepted" and never gets clicked. So: try a normal click; if it can't land, hover the
 * nearest stable ancestor (the card/row) to trip its `:hover` rule — leaving the mouse over it, so
 * the button stays `pointer-events: auto` — then click again.
 */
async function clickWithReveal(page: Page, fp: Fingerprint, locator: Locator, timeoutMs: number) {
  const ok = await locator
    .click({ timeout: Math.min(timeoutMs, 4_000) })
    .then(() => true)
    .catch(() => false);
  if (ok) return;
  const anchor = ancestorAnchor(page, fp);
  if (anchor) await anchor.hover({ timeout: 5_000 }).catch(() => undefined);
  await locator.click({ timeout: timeoutMs });
}

export async function applyWaits(page: Page, waits: Wait[] | undefined): Promise<void> {
  for (const w of waits ?? []) {
    if (w.kind === "delay") {
      await page.waitForTimeout(w.ms);
    } else if (w.kind === "networkIdle") {
      // Best-effort: a busy SPA (streaming lists, polling, lazy images) may NEVER reach network
      // idle, so a hard failure here makes networkIdle a footgun — the wait would fail the step
      // before the action's own locate/verify (the real gate) even runs. Settle up to the
      // timeout, then proceed. (Mirrors the pre-screenshot settle below.) Prefer a `selector`
      // wait when you need a hard gate on a specific element.
      await page.waitForLoadState("networkidle", { timeout: w.timeoutMs }).catch(() => undefined);
    } else {
      await waitLocator(page, w.target).waitFor({
        state: w.state,
        timeout: w.timeoutMs,
      });
    }
  }
}

/**
 * Perform one token-resolved ACTION step (navigate / click / type) against the page — the
 * shared drive primitive used by BOTH a full Run and the locator-verify probe, so "reached
 * step N" in verify means the same drive a Run performs. Click/type apply the given default
 * waits ahead of their own `waitBefore` (mirroring the run loop). A screenshot is not an
 * action (no-op — it doesn't change page state). Throws when a click/type target can't be
 * located. The step's tokens must already be resolved (via `resolveStep`).
 */
export async function performStepAction(
  page: Page,
  step: Step,
  defaultWaits: Wait[],
): Promise<void> {
  if (step.type === "navigate") {
    await page.goto(step.url, { waitUntil: "networkidle" });
    return;
  }
  if (step.type === "click" || step.type === "type" || step.type === "hover") {
    await applyWaits(page, [...defaultWaits, ...(step.waitBefore ?? [])]);
    // A prior click may have triggered an in-flight navigation; settle the document before
    // resolving, or the fingerprint would miss against a half-loaded page. Cheap when loaded.
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    // Patient resolve (the target may render a few seconds after navigation), with a hover-reveal
    // fallback for controls shown only on `:hover` (card/row edit & delete buttons).
    const target = await resolveWithHoverReveal(page, step.target, actionResolveTimeoutMs());
    if (!target) throw new Error(`could not locate ${step.type} target`);
    if (step.type === "type") await target.locator.fill(step.value);
    else if (step.type === "hover") await target.locator.hover();
    else await clickWithReveal(page, step.target, target.locator, actionResolveTimeoutMs());
  }
}

/**
 * Seed an environment's cookies onto a context BEFORE any navigation, so a test that needs
 * an existing session/consent cookie starts with it set. Values resolve the same
 * {{var}}/{{secret:NAME}} tokens steps do; domain falls back to the env's baseUrl. Shared by
 * the Run and the verify probe so both reach the same authenticated state.
 */
export async function seedCookies(
  context: BrowserContext,
  cookies: EnvCookie[],
  profile: EnvironmentProfile | null,
): Promise<void> {
  if (cookies.length === 0) return;
  const baseUrl = profile?.baseUrl;
  const toSet = cookies.map((c) => {
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

/** Derive an origin (scheme://host[:port]) from a URL-ish string, or null when it can't be parsed. */
function toOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Seed an environment's localStorage entries into the browser BEFORE any navigation, so a test
 * that needs an existing token/flag in `window.localStorage` starts with it set. localStorage is
 * per-origin, so each entry is written only when the page is on its `origin` (explicit, else the
 * env's baseUrl origin); an entry with no resolvable origin is written on every origin visited.
 * Values resolve the same {{var}}/{{secret:NAME}} tokens cookies and steps do. Shared by the Run
 * and the verify probe so both reach the same authenticated state.
 *
 * The seed runs via an init script whose SOURCE is a plain string (not a serialized function):
 * a serialized function would be rewritten by esbuild's keepNames (used by tsx in the worker) to
 * call a `__name` helper that doesn't exist in the page. The data is embedded as a JSON literal —
 * safe because it's injected as a script body via CDP, not into HTML.
 */
export async function seedLocalStorage(
  context: BrowserContext,
  items: EnvLocalStorageItem[],
  profile: EnvironmentProfile | null,
): Promise<void> {
  if (items.length === 0) return;
  const baseOrigin = toOrigin(profile?.baseUrl);
  const resolved = items.map((it) => ({
    key: it.key,
    value: profile ? resolveString(it.value, profile) : it.value,
    origin: it.origin ? (toOrigin(it.origin) ?? it.origin) : baseOrigin,
  }));
  const content = `(function () {
  try {
    var seed = ${JSON.stringify(resolved)};
    for (var i = 0; i < seed.length; i++) {
      var item = seed[i];
      if (item.origin && window.location.origin !== item.origin) continue;
      try { window.localStorage.setItem(item.key, item.value); } catch (e) {}
    }
  } catch (e) {}
})();`;
  await context.addInitScript({ content });
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

  // Team-wide diff defaults (Configurations page). Read once per run; a per-checkpoint
  // `step.threshold` still overrides the ratio below.
  const imageDefaults = await globalImageDefaults(db);

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
    // Load the run's environment (if any) — just the base URL for `{{baseUrl}}`, plus cookies +
    // localStorage seeded below. `{{baseUrl}}` is substituted per step in the loop below.
    let environment = "default";
    let profile: EnvironmentProfile | null = null;
    let envCookies: EnvCookie[] = [];
    let envLocalStorage: EnvLocalStorageItem[] = [];
    if (row.environmentId) {
      const [env] = await db
        .select({
          name: environments.name,
          baseUrl: environments.baseUrl,
          cookies: environments.cookies,
          localStorage: environments.localStorage,
        })
        .from(environments)
        .where(eq(environments.id, row.environmentId))
        .limit(1);
      if (!env) throw new Error(`Environment ${row.environmentId} not found`);
      profile = { baseUrl: env.baseUrl ?? "" };
      environment = env.name;
      envCookies = (env.cookies ?? []) as EnvCookie[];
      envLocalStorage = (env.localStorage ?? []) as EnvLocalStorageItem[];
    }
    const vpKey = viewportKey(recorded.viewport);

    browser = await chromium.launch({ args: browserLaunchArgs() });
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

    // Seed the environment's cookies + localStorage onto the context BEFORE any navigation
    // (keep real auth tokens in a write-only secret and reference them via {{secret:NAME}}).
    await seedCookies(context, envCookies, profile);
    await seedLocalStorage(context, envLocalStorage, profile);

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

      // Action steps (navigate / click / hover / type) go through the shared drive primitive so a
      // Run and the verify probe reach state identically. Screenshots fall through below.
      if (
        step.type === "navigate" ||
        step.type === "click" ||
        step.type === "hover" ||
        step.type === "type"
      ) {
        await performStepAction(page, step, resolvedDefaultWaits);
        recordStep("passed");
        continue;
      }

      // Screenshot: apply the same waits the run always did (defaults + own), then settle
      // the network before capturing the checkpoint.
      await applyWaits(page, [...resolvedDefaultWaits, ...(step.waitBefore ?? [])]);
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
        const found = await resolveWithHoverReveal(page, step.target, actionResolveTimeoutMs());
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
      // Per-checkpoint override wins; else the team default; else the built-in.
      const threshold = step.threshold ?? imageDefaults.ratio;

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
          imageDefaults.perPixel,
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

/** Thrown by `verifyLocatorAtStep` when a newer verify supersedes it mid-drive
 *  (cooperative single-flight). The caller maps this to a "superseded" response. */
export class LocatorVerifyAbortedError extends Error {
  constructor() {
    super("locator verify superseded");
    this.name = "LocatorVerifyAbortedError";
  }
}

export interface VerifyLocatorParams {
  /** The test's latest definition (the steps to drive + viewport). */
  definition: TestDefinition;
  /** 0-based index of the step whose locator is being verified (must be targetable). */
  stepIndex: number;
  /** The candidate fingerprint to resolve at `stepIndex` — already merged by the caller
   *  (its `{{tokens}}` are resolved here against `profile`, like a run would). */
  candidate: Fingerprint;
  /** Per-environment values/secrets for token resolution; null = env-less ("default"). */
  profile: EnvironmentProfile | null;
  /** Cookies seeded onto the context before the drive (env-scoped). */
  cookies: EnvCookie[];
  /** localStorage entries seeded into the browser before the drive (env-scoped). */
  localStorage: EnvLocalStorageItem[];
  /** Cooperative cancel, checked between drive steps so a newer verify supersedes this. */
  shouldAbort?: () => boolean;
  /** Per-operation timeout (navigation/action). Defaults to 15s. */
  timeoutMs?: number;
}

export interface VerifyLocatorOutcome {
  status: "resolved" | "ambiguous" | "not-found";
  matchedSignal: string | null;
  healed: boolean;
  reachedStep: number;
  failedStepIndex: number | null;
  failedStepLabel: string | null;
}

/**
 * The locator-verify probe (Slice 16.3a): a transient, artifact-free PARTIAL REPLAY. Launch
 * a short-lived browser, seed cookies, drive steps `[0..stepIndex)` with the SAME drive
 * primitive a Run uses (`performStepAction`), then resolve the candidate locator at
 * `stepIndex` with the SAME matcher (`@varys/locator-engine`). So "resolved here" means
 * "resolves at Run time". Writes nothing — no run row, no results, no baselines, no
 * artifacts, no queue job. A step the drive can't perform is reported (not thrown) so the
 * caller can tell "wrong locator" from "broken path to the step".
 */
export async function verifyLocatorAtStep(params: VerifyLocatorParams): Promise<VerifyLocatorOutcome> {
  const { definition, stepIndex, candidate, profile, cookies, localStorage, shouldAbort, timeoutMs = 15_000 } = params;
  const aborted = (): boolean => shouldAbort?.() ?? false;
  const miss = (i: number, label: string): VerifyLocatorOutcome => ({
    status: "not-found",
    matchedSignal: null,
    healed: false,
    reachedStep: i,
    failedStepIndex: i,
    failedStepLabel: label,
  });

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await chromium.launch({ args: browserLaunchArgs() });
    context = await browser.newContext({
      viewport: { width: definition.viewport.width, height: definition.viewport.height },
      deviceScaleFactor: definition.viewport.deviceScaleFactor,
      reducedMotion: "reduce",
    });
    context.setDefaultTimeout(timeoutMs);
    context.setDefaultNavigationTimeout(timeoutMs);
    await seedCookies(context, cookies, profile);
    await seedLocalStorage(context, localStorage, profile);
    const page = await context.newPage();

    const defaultWaits = definition.defaults?.waitBefore ?? [];
    const resolvedDefaultWaits = profile ? resolveWaits(defaultWaits, profile) : defaultWaits;

    // Drive the preceding steps to reach the page state. A failure (unresolvable token,
    // unlocatable target, navigation error) is reported as the broken step, not thrown.
    for (let i = 0; i < stepIndex; i++) {
      if (aborted()) throw new LocatorVerifyAbortedError();
      const raw = definition.steps[i];
      try {
        const step = profile ? resolveStep(raw, profile) : raw;
        await performStepAction(page, step, resolvedDefaultWaits); // screenshots are no-ops
      } catch {
        return miss(i, describeStep(raw));
      }
    }
    if (aborted()) throw new LocatorVerifyAbortedError();

    // At the target step: resolve the candidate's tokens, apply the same waits the run would,
    // then run the real matcher's verify verdict.
    const rawAtN = definition.steps[stepIndex];
    const withCandidate = { ...rawAtN, target: candidate } as Step;
    const resolvedN = profile ? resolveStep(withCandidate, profile) : withCandidate;
    const resolvedTarget = ("target" in resolvedN ? resolvedN.target : undefined) ?? candidate;
    const stepWaits = "waitBefore" in resolvedN ? (resolvedN.waitBefore ?? []) : [];
    try {
      await applyWaits(page, [...resolvedDefaultWaits, ...stepWaits]);
      if (rawAtN.type === "screenshot") {
        await page.waitForLoadState("networkidle").catch(() => undefined);
      } else {
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      }
    } catch {
      // A wait that can't settle is a property of the page state at the step, not the
      // locator — fall through and let the matcher report on the candidate as-is.
    }
    const v = await verify(page, resolvedTarget, { timeoutMs: Math.min(timeoutMs, 5_000) });
    return {
      status: v.status,
      matchedSignal: v.matchedSignal,
      healed: v.healed,
      reachedStep: stepIndex,
      failedStepIndex: null,
      failedStepLabel: null,
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
