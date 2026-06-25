import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  baselines,
  environments,
  runResults,
  runs,
  runSteps,
  testVersions,
  tests,
} from "@varys/db";
import { diffPng } from "@varys/diff-engine";
import { type Boss, enqueueRun } from "@varys/queue";
import type {
  CaptureMode,
  CheckpointView,
  FingerprintSummary,
  NeedsReviewItem,
  PersistResult,
  ReEvaluation,
  Rect,
  Resolution,
  ReviewState,
  RunSummary,
  RunView,
  StepLabel,
  StepRun,
  TuningInput,
} from "@varys/review-contract";
import { deriveRunOutcome } from "@varys/review-contract";
import { describeStep, type TestDefinition } from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { summarizeFingerprint } from "../fingerprint-summary";
import { BOSS } from "../queue/queue.module";
import { SettingsService } from "../settings/settings.service";
import { STORAGE } from "../storage/storage.module";

const ENVIRONMENT = "default";

function viewportKey(vp: TestDefinition["viewport"]): string {
  return `${vp.width}x${vp.height}@${vp.deviceScaleFactor}`;
}

/** The recorded target fingerprint per step, indexed by step position — what the
 *  locator looks for. Null for steps with no element target (navigate, full-page /
 *  region screenshot). The definition already holds this, so it's free to surface. */
function buildFingerprints(def: TestDefinition): (FingerprintSummary | null)[] {
  return def.steps.map((s) => ("target" in s ? summarizeFingerprint(s.target) : null));
}

export interface CreatedRun {
  runId: string;
}

// The per-checkpoint review read-model (CheckpointView / RunView) is the shared
// API↔UI contract — see @varys/review-contract.

@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: Boss,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
    // Supplies the team-wide per-pixel default so in-viewer re-evaluation matches the runner.
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async create(
    testId: string,
    opts: {
      environmentId?: string;
      suiteRunId?: string;
      trace?: boolean;
      /** Who triggered this run (email / sentinel) and how it was triggered. */
      triggeredBy?: string;
      triggerSource?: "manual" | "suite" | "schedule" | "api";
    } = {},
  ): Promise<CreatedRun> {
    const [version] = await this.db
      .select({ id: testVersions.id })
      .from(testVersions)
      .where(eq(testVersions.testId, testId))
      .orderBy(desc(testVersions.version))
      .limit(1);
    if (!version) throw new NotFoundException(`Test ${testId} not found`);

    const [run] = await this.db
      .insert(runs)
      .values({
        testVersionId: version.id,
        environmentId: opts.environmentId ?? null,
        suiteRunId: opts.suiteRunId ?? null,
        trace: opts.trace ?? false,
        triggeredBy: opts.triggeredBy ?? null,
        triggerSource: opts.triggerSource ?? null,
        status: "queued",
      })
      .returning({ id: runs.id });

    await enqueueRun(this.boss, run.id);
    return { runId: run.id };
  }

  async getById(runId: string): Promise<RunView> {
    const [row] = await this.db
      .select({
        status: runs.status,
        createdAt: runs.createdAt,
        environmentId: runs.environmentId,
        error: runs.error,
        failedStepIndex: runs.failedStepIndex,
        traceArtifactKey: runs.traceArtifactKey,
        triggeredBy: runs.triggeredBy,
        triggerSource: runs.triggerSource,
        notes: runs.notes,
        testId: testVersions.testId,
        testName: tests.name,
        definition: testVersions.definition,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .where(eq(runs.id, runId))
      .limit(1);
    if (!row) throw new NotFoundException(`Run ${runId} not found`);

    // Capture mode lives on the screenshot step of the version that ran; map it by
    // checkpoint name (absent ⇒ element, for definitions recorded before capture modes).
    const captureModes = new Map<string, CaptureMode>();
    for (const s of (row.definition as TestDefinition).steps) {
      if (s.type === "screenshot") captureModes.set(s.name, s.captureMode ?? "element");
    }

    // Masks are the *current* ones a reviewer would edit — from the latest version,
    // which after a persist holds the just-saved masks (the run's own version may be older).
    const masksByName = new Map<string, Rect[]>();
    const latestDef = await this.latestDefinition(row.testId);
    for (const s of latestDef.steps) {
      if (s.type === "screenshot") masksByName.set(s.name, (s.masks ?? []) as Rect[]);
    }

    // Environment name for the reviewer's context; "default" when none was chosen.
    const environment = await this.environmentName(row.environmentId);

    const results = await this.db
      .select({
        name: runResults.checkpointName,
        reviewState: runResults.reviewState,
        resolution: runResults.resolution,
        resolvedBy: runResults.resolvedBy,
        resolvedAt: runResults.resolvedAt,
        diffScore: runResults.diffScore,
        threshold: runResults.threshold,
        healed: runResults.healed,
        actualArtifactKey: runResults.actualArtifactKey,
        baselineArtifactKey: runResults.baselineArtifactKey,
        diffArtifactKey: runResults.diffArtifactKey,
        createdAt: runResults.createdAt,
      })
      .from(runResults)
      .where(eq(runResults.runId, runId));

    // A run that was re-executed (e.g. redelivered by the queue before idempotent
    // writes landed) can carry more than one row per checkpoint. Collapse to the
    // latest pass per checkpoint name so the viewer never shows a checkpoint twice.
    // Belt-and-braces: the unique index on (run_id, checkpoint_name) now prevents
    // new dupes, but historical runs predate it.
    const latestResultByName = new Map<string, (typeof results)[number]>();
    for (const r of results) {
      const prev = latestResultByName.get(r.name);
      if (!prev || r.createdAt > prev.createdAt) latestResultByName.set(r.name, r);
    }
    const dedupedResults = [...latestResultByName.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    const url = (key: string | null) => (key ? this.storage.getUrl(key) : null);

    // Baseline audit trail per checkpoint: who approved the current golden for this
    // (test, checkpoint, env, viewport) and when. Surfaces the real approver (Slice 10).
    const vpKey = viewportKey((row.definition as TestDefinition).viewport);
    const baselineRows = await this.db
      .select({
        checkpointName: baselines.checkpointName,
        approvedBy: baselines.approvedBy,
        approvedAt: baselines.approvedAt,
      })
      .from(baselines)
      .where(
        and(
          eq(baselines.testId, row.testId),
          eq(baselines.environment, environment),
          eq(baselines.viewportKey, vpKey),
        ),
      );
    const baselineByName = new Map(baselineRows.map((b) => [b.checkpointName, b]));

    // For a failed run there are no checkpoints — instead give the viewer the run's
    // step sequence (labels) so it can show which step failed and which never ran.
    const steps: StepLabel[] =
      row.status === "failed"
        ? (row.definition as TestDefinition).steps.map((s, index) => ({
            index,
            label: describeStep(s),
          }))
        : [];

    // The per-step execution timeline (every run): the steps that actually ran,
    // in order, with timing + outcome — the custom-timeline foundation.
    const stepRows = await this.db
      .select({
        index: runSteps.stepIndex,
        label: runSteps.label,
        checkpointName: runSteps.checkpointName,
        startedAt: runSteps.startedAt,
        durationMs: runSteps.durationMs,
        outcome: runSteps.outcome,
      })
      .from(runSteps)
      .where(eq(runSteps.runId, runId))
      .orderBy(runSteps.stepIndex);
    // Collapse duplicate passes: keep the latest row per step_index (the most recent
    // execution). Same defensiveness as the checkpoints above — the unique index on
    // (run_id, step_index) prevents new dupes; this fixes already-duplicated runs.
    const latestStepByIndex = new Map<number, (typeof stepRows)[number]>();
    for (const s of stepRows) {
      const prev = latestStepByIndex.get(s.index);
      if (!prev || s.startedAt > prev.startedAt) latestStepByIndex.set(s.index, s);
    }
    const timeline: StepRun[] = [...latestStepByIndex.values()]
      .sort((a, b) => a.index - b.index)
      .map((s) => ({
        index: s.index,
        label: s.label,
        checkpointName: s.checkpointName,
        startedAt: s.startedAt.toISOString(),
        durationMs: s.durationMs,
        outcome: s.outcome as "passed" | "failed",
      }));

    const checkpoints: CheckpointView[] = dedupedResults.map(
      (r): CheckpointView => ({
        name: r.name,
        reviewState: r.reviewState as ReviewState,
        captureMode: captureModes.get(r.name) ?? "element",
        resolution: r.resolution as Resolution | null,
        resolvedBy: r.resolvedBy,
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        diffScore: r.diffScore,
        threshold: r.threshold,
        healed: r.healed,
        masks: masksByName.get(r.name) ?? [],
        actualUrl: url(r.actualArtifactKey),
        baselineUrl: url(r.baselineArtifactKey),
        diffUrl: url(r.diffArtifactKey),
        baselineApprovedBy: baselineByName.get(r.name)?.approvedBy ?? null,
        baselineApprovedAt: baselineByName.get(r.name)?.approvedAt?.toISOString() ?? null,
      }),
    );

    return {
      runId,
      status: row.status,
      // Derived display refinement — baseline-creation vs verification (see deriveRunOutcome).
      outcome: deriveRunOutcome(checkpoints, { status: row.status, error: row.error }),
      testName: row.testName,
      environment,
      runTimestamp: row.createdAt.toISOString(),
      triggeredBy: row.triggeredBy,
      triggerSource: row.triggerSource,
      error: row.error,
      steps,
      failedStepIndex: row.failedStepIndex ?? null,
      fingerprints: buildFingerprints(row.definition as TestDefinition),
      traceUrl: url(row.traceArtifactKey),
      timeline,
      notes: row.notes ?? null,
      checkpoints,
    };
  }

  /** The latest version's definition for a test (the source of "current" masks/threshold). */
  private async latestDefinition(testId: string): Promise<TestDefinition> {
    const [row] = await this.db
      .select({ definition: testVersions.definition })
      .from(testVersions)
      .where(eq(testVersions.testId, testId))
      .orderBy(desc(testVersions.version))
      .limit(1);
    if (!row) throw new NotFoundException(`No versions for test ${testId}`);
    return row.definition as TestDefinition;
  }

  /**
   * The run's environment NAME — the key baselines are stored and looked up under.
   * "default" when the run had no environment, or its environment was deleted (a
   * dangling id degrades gracefully). Mirrors the runner's own resolution so approve
   * seeds/replaces under the very environment the run executed against.
   */
  private async environmentName(environmentId: string | null): Promise<string> {
    if (!environmentId) return ENVIRONMENT;
    const [env] = await this.db
      .select({ name: environments.name })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .limit(1);
    return env?.name ?? ENVIRONMENT;
  }

  /** Every STANDALONE run, newest first — the Runs history (all outcomes).
   *  Suite-run children are excluded: they surface through their parent's
   *  aggregate row + report, so one fan-out doesn't flood the flat list.
   *  Pass `testId` to scope to one test's run history (the TestDetail panel). */
  async listRuns(limit = 100, testId?: string): Promise<RunSummary[]> {
    const rows = await this.db
      .select({
        runId: runs.id,
        status: runs.status,
        environmentId: runs.environmentId,
        error: runs.error,
        createdAt: runs.createdAt,
        triggeredBy: runs.triggeredBy,
        triggerSource: runs.triggerSource,
        testName: tests.name,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .where(
        testId ? and(isNull(runs.suiteRunId), eq(testVersions.testId, testId)) : isNull(runs.suiteRunId),
      )
      .orderBy(desc(runs.createdAt))
      .limit(limit);

    // Resolve environment names in one batch ("default" when a run has no env).
    const envIds = [
      ...new Set(rows.map((r) => r.environmentId).filter((x): x is string => x != null)),
    ];
    const envNames = new Map<string, string>();
    if (envIds.length) {
      const envs = await this.db
        .select({ id: environments.id, name: environments.name })
        .from(environments)
        .where(inArray(environments.id, envIds));
      for (const e of envs) envNames.set(e.id, e.name);
    }

    // One batched read of every listed run's checkpoint verdicts, grouped per run, so the
    // display outcome (baseline vs verified, …) is derived once via the shared helper.
    const runIds = rows.map((r) => r.runId);
    const checkpointsByRun = new Map<string, { reviewState: ReviewState; resolution: Resolution | null }[]>();
    if (runIds.length) {
      const resultRows = await this.db
        .select({
          runId: runResults.runId,
          reviewState: runResults.reviewState,
          resolution: runResults.resolution,
        })
        .from(runResults)
        .where(inArray(runResults.runId, runIds));
      for (const rr of resultRows) {
        const list = checkpointsByRun.get(rr.runId) ?? [];
        list.push({ reviewState: rr.reviewState as ReviewState, resolution: rr.resolution as Resolution | null });
        checkpointsByRun.set(rr.runId, list);
      }
    }

    return rows.map(
      (r): RunSummary => ({
        runId: r.runId,
        testName: r.testName,
        environment: r.environmentId ? (envNames.get(r.environmentId) ?? ENVIRONMENT) : ENVIRONMENT,
        status: r.status,
        outcome: deriveRunOutcome(checkpointsByRun.get(r.runId) ?? [], { status: r.status, error: r.error }),
        runTimestamp: r.createdAt.toISOString(),
        error: r.error,
        triggeredBy: r.triggeredBy,
        triggerSource: r.triggerSource,
      }),
    );
  }

  /** Set (or clear) a run's free-form note. Empty/whitespace clears it (→ null). 404 if
   *  the run doesn't exist. Annotation only — touches nothing else about the run. */
  async setNotes(runId: string, notes: string | null): Promise<{ ok: true }> {
    const trimmed = (notes ?? "").trim();
    const updated = await this.db
      .update(runs)
      .set({ notes: trimmed || null, updatedAt: new Date() })
      .where(eq(runs.id, runId))
      .returning({ id: runs.id });
    if (updated.length === 0) throw new NotFoundException(`Run ${runId} not found`);
    return { ok: true };
  }

  /**
   * Delete a single run and its output — `run_results` + `run_steps`, then the run row.
   * Irreversible, no rollback. Orphaned artifact blobs (the run's trace and each
   * checkpoint's actual + diff screenshots) are purged best-effort afterwards; a blob the
   * `baselines` table still points at (an `actual` that was approved into the live golden)
   * is KEPT, as is the shared baseline key. `test_schedules.lastRunId` clears itself via
   * its ON DELETE SET NULL FK.
   */
  async deleteRun(runId: string): Promise<{ ok: true }> {
    const [run] = await this.db
      .select({ id: runs.id, trace: runs.traceArtifactKey })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) throw new NotFoundException(`Run ${runId} not found`);

    // Blobs this run owns: its trace + each result's actual/diff. NOT the baseline key —
    // that blob belongs to the `baselines` table (the golden), shared across runs.
    const results = await this.db
      .select({ actual: runResults.actualArtifactKey, diff: runResults.diffArtifactKey })
      .from(runResults)
      .where(eq(runResults.runId, runId));
    const keys = new Set<string>();
    if (run.trace) keys.add(run.trace);
    for (const r of results) for (const k of [r.actual, r.diff]) if (k) keys.add(k);

    // An approved checkpoint's `actual` becomes the live golden (approve reuses the key),
    // so never purge a blob the baselines table still references.
    if (keys.size) {
      const live = await this.db
        .select({ key: baselines.artifactKey })
        .from(baselines)
        .where(inArray(baselines.artifactKey, [...keys]));
      for (const b of live) keys.delete(b.key);
    }

    // Non-cascading FK chain: results + steps before the run row, in one transaction.
    await this.db.transaction(async (tx) => {
      await tx.delete(runResults).where(eq(runResults.runId, runId));
      await tx.delete(runSteps).where(eq(runSteps.runId, runId));
      await tx.delete(runs).where(eq(runs.id, runId));
    });

    // The DB delete is the source of truth — an orphaned blob is harmless, so purge after.
    for (const key of keys) {
      await this.storage.delete(key).catch(() => undefined);
    }
    return { ok: true };
  }

  /** The flat "needs review" list: checkpoints awaiting a decision
   *  (pending-baseline | diff, not yet resolved), newest run first. */
  async needsReview(): Promise<NeedsReviewItem[]> {
    const rows = await this.db
      .select({
        runId: runs.id,
        testName: tests.name,
        environmentId: runs.environmentId,
        runTimestamp: runs.createdAt,
        checkpointName: runResults.checkpointName,
        reviewState: runResults.reviewState,
      })
      .from(runResults)
      .innerJoin(runs, eq(runs.id, runResults.runId))
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .where(
        and(
          inArray(runResults.reviewState, ["pending-baseline", "diff"]),
          isNull(runResults.resolution),
        ),
      )
      .orderBy(desc(runs.createdAt));

    // Resolve environment names in one batch ("default" when a run has no env).
    const envIds = [
      ...new Set(rows.map((r) => r.environmentId).filter((x): x is string => x != null)),
    ];
    const envNames = new Map<string, string>();
    if (envIds.length) {
      const envs = await this.db
        .select({ id: environments.id, name: environments.name })
        .from(environments)
        .where(inArray(environments.id, envIds));
      for (const e of envs) envNames.set(e.id, e.name);
    }

    return rows.map(
      (r): NeedsReviewItem => ({
        runId: r.runId,
        testName: r.testName,
        environment: r.environmentId ? (envNames.get(r.environmentId) ?? ENVIRONMENT) : ENVIRONMENT,
        runTimestamp: r.runTimestamp.toISOString(),
        checkpointName: r.checkpointName,
        reviewState: r.reviewState as Exclude<ReviewState, "passed">,
      }),
    );
  }

  /**
   * Re-derive a run's review status from its checkpoints after a decision
   * (approve / reject) or a mask-threshold re-judge. The worker stamps `runs.status`
   * once at replay time, so without this the Runs table (and dashboard / detail header,
   * which all read the stored column) keep showing "needs review" after the last
   * checkpoint is resolved.
   *
   * Only post-review statuses roll up. Execution-failed runs are left as-is —
   * reviewing the partial checkpoints a run captured before it failed must not flip it
   * to passed — and queued/running are owned by the worker. Per-checkpoint effective
   * status mirrors the UI: approved→passed, rejected→regression, else the stored
   * reviewState; rollup is any-pending→needs_review, else any-rejected→failed, else passed.
   */
  private async recomputeRunStatus(runId: string): Promise<void> {
    const [run] = await this.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run || (run.status !== "passed" && run.status !== "needs_review")) return;

    const results = await this.db
      .select({ reviewState: runResults.reviewState, resolution: runResults.resolution })
      .from(runResults)
      .where(eq(runResults.runId, runId));

    let anyPending = false;
    let anyRejected = false;
    for (const r of results) {
      if (r.resolution === "rejected") anyRejected = true;
      else if (r.resolution === "approved") continue; // resolved → passed
      else if (r.reviewState === "pending-baseline" || r.reviewState === "diff") anyPending = true;
    }
    const next = anyPending ? "needs_review" : anyRejected ? "failed" : "passed";
    if (next === run.status) return;
    await this.db.update(runs).set({ status: next, updatedAt: new Date() }).where(eq(runs.id, runId));
  }

  /** Approve a checkpoint: promote a pending seed (or replace an active baseline) and audit it.
   *  `approvedBy` is the signed-in user (the irreversible action's audit trail, DESIGN §4). */
  async approve(runId: string, checkpointName: string, approvedBy: string): Promise<{ ok: true }> {
    const [result] = await this.db
      .select({
        id: runResults.id,
        reviewState: runResults.reviewState,
        actualArtifactKey: runResults.actualArtifactKey,
        resolution: runResults.resolution,
      })
      .from(runResults)
      .where(
        and(eq(runResults.runId, runId), eq(runResults.checkpointName, checkpointName)),
      )
      .limit(1);
    if (!result) {
      throw new NotFoundException(`Checkpoint ${checkpointName} not found for run ${runId}`);
    }
    if (result.resolution) {
      throw new ConflictException(`Checkpoint already ${result.resolution}`);
    }

    const [ctx] = await this.db
      .select({
        testId: testVersions.testId,
        definition: testVersions.definition,
        environmentId: runs.environmentId,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .where(eq(runs.id, runId))
      .limit(1);
    if (!ctx) throw new NotFoundException(`Run ${runId} not found`);
    const vpKey = viewportKey((ctx.definition as TestDefinition).viewport);
    // Seed/replace under the run's OWN environment, not a hardcoded "default" — else
    // the next run against that environment never finds the baseline. (Slice 2 fix.)
    // reEvaluate/persistMasks touch no baselines, so they're unaffected by env.
    const environment = await this.environmentName(ctx.environmentId);

    if (result.reviewState === "pending-baseline") {
      if (!result.actualArtifactKey) {
        throw new BadRequestException("no actual artifact to promote");
      }
      await this.db.insert(baselines).values({
        testId: ctx.testId,
        checkpointName,
        environment,
        viewportKey: vpKey,
        artifactKey: result.actualArtifactKey,
        approvedBy,
        approvedAt: new Date(),
      });
    } else if (result.reviewState === "diff" || result.reviewState === "passed") {
      // `diff` = an over-threshold change accepted as the new golden.
      // `passed` = re-baseline a *passing* capture (Slice 17.4): re-anchor the golden to
      // this run's actual even though it matched (e.g. to lock in accepted drift). Both
      // replace the existing golden identically — a passing checkpoint always has one.
      const [existing] = await this.db
        .select({ id: baselines.id, artifactKey: baselines.artifactKey })
        .from(baselines)
        .where(
          and(
            eq(baselines.testId, ctx.testId),
            eq(baselines.checkpointName, checkpointName),
            eq(baselines.environment, environment),
            eq(baselines.viewportKey, vpKey),
          ),
        )
        .limit(1);
      if (!existing) throw new ConflictException("no active baseline to replace");
      if (!result.actualArtifactKey) {
        throw new BadRequestException("no actual artifact to promote");
      }
      const oldKey = existing.artifactKey;
      await this.db
        .update(baselines)
        .set({
          artifactKey: result.actualArtifactKey,
          approvedBy,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(baselines.id, existing.id));
      if (oldKey !== result.actualArtifactKey) {
        // Replace is destructive — the old golden is gone (no rollback, DESIGN §4).
        await this.storage.delete(oldKey);
      }
    } else {
      throw new BadRequestException(
        `nothing to approve (reviewState=${result.reviewState})`,
      );
    }

    await this.db
      .update(runResults)
      .set({ resolution: "approved", resolvedBy: approvedBy, resolvedAt: new Date() })
      .where(eq(runResults.id, result.id));
    await this.recomputeRunStatus(runId);
    return { ok: true };
  }

  /**
   * Bulk-approve every checkpoint in a run that still needs review
   * (`pending-baseline` | `diff`, undecided), in one audited operation. Each is
   * approved via the single-checkpoint path, so it seeds/replaces and audits its
   * baseline identically. Passing and already-decided checkpoints are left
   * untouched. Bulk reject is intentionally out of scope.
   */
  async approveAll(runId: string, approvedBy: string): Promise<{ approved: number }> {
    const candidates = await this.db
      .select({ name: runResults.checkpointName })
      .from(runResults)
      .where(
        and(
          eq(runResults.runId, runId),
          inArray(runResults.reviewState, ["pending-baseline", "diff"]),
          isNull(runResults.resolution),
        ),
      );
    for (const c of candidates) {
      await this.approve(runId, c.name, approvedBy);
    }
    return { approved: candidates.length };
  }

  /** Reject a checkpoint: record a regression; the baseline is left untouched.
   *  `resolvedBy` is the signed-in user (audit pair with the recorded decision). */
  async reject(runId: string, checkpointName: string, resolvedBy: string): Promise<{ ok: true }> {
    const [result] = await this.db
      .select({ id: runResults.id, reviewState: runResults.reviewState, resolution: runResults.resolution })
      .from(runResults)
      .where(
        and(eq(runResults.runId, runId), eq(runResults.checkpointName, checkpointName)),
      )
      .limit(1);
    if (!result) {
      throw new NotFoundException(`Checkpoint ${checkpointName} not found for run ${runId}`);
    }
    if (result.resolution) {
      throw new ConflictException(`Checkpoint already ${result.resolution}`);
    }
    // A passing checkpoint matched its baseline — there's nothing to reject (you'd
    // re-baseline it via approve instead).
    if (result.reviewState === "passed") {
      throw new BadRequestException("can't reject a passing checkpoint");
    }
    await this.db
      .update(runResults)
      .set({ resolution: "rejected", resolvedBy, resolvedAt: new Date() })
      .where(eq(runResults.id, result.id));
    await this.recomputeRunStatus(runId);
    return { ok: true };
  }

  /**
   * Re-evaluate (preview): re-diff a checkpoint's STORED baseline+actual with
   * candidate masks/threshold — no browser, no new capture, no mutation. Returns
   * the new verdict/score and a transient diff image (data URL) for live display.
   */
  async reEvaluate(
    runId: string,
    checkpointName: string,
    input: TuningInput,
  ): Promise<ReEvaluation> {
    const [r] = await this.db
      .select({
        baselineArtifactKey: runResults.baselineArtifactKey,
        actualArtifactKey: runResults.actualArtifactKey,
        threshold: runResults.threshold,
      })
      .from(runResults)
      .where(and(eq(runResults.runId, runId), eq(runResults.checkpointName, checkpointName)))
      .limit(1);
    if (!r) {
      throw new NotFoundException(`Checkpoint ${checkpointName} not found for run ${runId}`);
    }
    const { baseline, actual } = await this.loadDiffInputs(
      r.baselineArtifactKey,
      r.actualArtifactKey,
    );
    const threshold = input.threshold ?? r.threshold;
    const { perPixel } = await this.settings.getImageComparison();
    const { verdict, score, diffImage } = diffPng(
      baseline,
      actual,
      threshold,
      input.masks ?? [],
      perPixel,
    );
    return {
      verdict,
      diffScore: score,
      threshold,
      diffImage: `data:image/png;base64,${diffImage.toString("base64")}`,
    };
  }

  /**
   * Persist masks/threshold: write a NEW test_version (latest+1) with the named
   * screenshot step's masks/threshold updated (audited), then re-judge ONLY this
   * checkpoint's run_result against the stored artifacts. A now-within-threshold
   * checkpoint flips to `passed` and leaves the needs-review list. Future runs use
   * the new version; no other historical run is touched.
   */
  async persistMasks(
    runId: string,
    checkpointName: string,
    input: TuningInput,
    createdBy: string,
  ): Promise<PersistResult> {
    const [ctx] = await this.db
      .select({
        testId: testVersions.testId,
        runResultId: runResults.id,
        baselineArtifactKey: runResults.baselineArtifactKey,
        actualArtifactKey: runResults.actualArtifactKey,
        threshold: runResults.threshold,
      })
      .from(runResults)
      .innerJoin(runs, eq(runs.id, runResults.runId))
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .where(and(eq(runResults.runId, runId), eq(runResults.checkpointName, checkpointName)))
      .limit(1);
    if (!ctx) {
      throw new NotFoundException(`Checkpoint ${checkpointName} not found for run ${runId}`);
    }
    const { baseline, actual } = await this.loadDiffInputs(
      ctx.baselineArtifactKey,
      ctx.actualArtifactKey,
    );

    // 1. New audited test_version with the updated masks/threshold on this step.
    const def = await this.latestDefinition(ctx.testId);
    const [latest] = await this.db
      .select({ version: testVersions.version })
      .from(testVersions)
      .where(eq(testVersions.testId, ctx.testId))
      .orderBy(desc(testVersions.version))
      .limit(1);
    const masks = (input.masks ?? []) as Rect[];
    const nextDefinition: TestDefinition = {
      ...def,
      steps: def.steps.map((s) =>
        s.type === "screenshot" && s.name === checkpointName
          ? { ...s, masks, ...(input.threshold != null ? { threshold: input.threshold } : {}) }
          : s,
      ),
    };
    const nextVersion = (latest?.version ?? 1) + 1;
    await this.db.insert(testVersions).values({
      testId: ctx.testId,
      version: nextVersion,
      definition: nextDefinition,
      createdBy,
    });

    // 2. Re-judge ONLY this run_result against the stored artifacts.
    const threshold = input.threshold ?? ctx.threshold;
    const { perPixel } = await this.settings.getImageComparison();
    const { verdict, score, diffImage } = diffPng(baseline, actual, threshold, masks, perPixel);
    if (verdict === "match") {
      await this.db
        .update(runResults)
        .set({ reviewState: "passed", diffScore: score, threshold, diffArtifactKey: null })
        .where(eq(runResults.id, ctx.runResultId));
    } else {
      const diffKey = `runs/${runId}/${checkpointName}.diff.png`;
      await this.storage.put(diffKey, diffImage);
      await this.db
        .update(runResults)
        .set({ reviewState: "diff", diffScore: score, threshold, diffArtifactKey: diffKey })
        .where(eq(runResults.id, ctx.runResultId));
    }
    // Tuning a diff back within threshold resolves the last pending checkpoint — keep
    // the run's stored status in step with that, same as approve/reject.
    await this.recomputeRunStatus(runId);
    return {
      reviewState: verdict === "match" ? "passed" : "diff",
      diffScore: score,
      threshold,
      version: nextVersion,
    };
  }

  /** Load a checkpoint's stored baseline+actual bytes for an in-place re-diff. */
  private async loadDiffInputs(
    baselineKey: string | null,
    actualKey: string | null,
  ): Promise<{ baseline: Buffer; actual: Buffer }> {
    if (!baselineKey || !actualKey) {
      throw new BadRequestException("checkpoint has no baseline to re-evaluate against");
    }
    const baseline = await this.storage.get(baselineKey);
    const actual = await this.storage.get(actualKey);
    if (!baseline || !actual) throw new BadRequestException("stored artifacts are missing");
    return { baseline, actual };
  }
}
