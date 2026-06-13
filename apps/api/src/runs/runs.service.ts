import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { baselines, environments, runResults, runs, testVersions, tests } from "@varys/db";
import { diffPng } from "@varys/diff-engine";
import { type Boss, enqueueRun } from "@varys/queue";
import type {
  CaptureMode,
  CheckpointView,
  NeedsReviewItem,
  PersistResult,
  ReEvaluation,
  Rect,
  Resolution,
  ReviewState,
  RunSummary,
  RunView,
  StepLabel,
  TuningInput,
} from "@varys/review-contract";
import { describeStep, type TestDefinition } from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { BOSS } from "../queue/queue.module";
import { STORAGE } from "../storage/storage.module";

const ENVIRONMENT = "default";

function viewportKey(vp: TestDefinition["viewport"]): string {
  return `${vp.width}x${vp.height}@${vp.deviceScaleFactor}`;
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
  ) {}

  async create(
    testId: string,
    opts: { environmentId?: string; suiteRunId?: string; trace?: boolean } = {},
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
        diffScore: runResults.diffScore,
        threshold: runResults.threshold,
        healed: runResults.healed,
        actualArtifactKey: runResults.actualArtifactKey,
        baselineArtifactKey: runResults.baselineArtifactKey,
        diffArtifactKey: runResults.diffArtifactKey,
      })
      .from(runResults)
      .where(eq(runResults.runId, runId));

    const url = (key: string | null) => (key ? this.storage.getUrl(key) : null);

    // For a failed run there are no checkpoints — instead give the viewer the run's
    // step sequence (labels) so it can show which step failed and which never ran.
    const steps: StepLabel[] =
      row.status === "failed"
        ? (row.definition as TestDefinition).steps.map((s, index) => ({
            index,
            label: describeStep(s),
          }))
        : [];

    return {
      runId,
      status: row.status,
      testName: row.testName,
      environment,
      runTimestamp: row.createdAt.toISOString(),
      error: row.error,
      steps,
      failedStepIndex: row.failedStepIndex ?? null,
      traceUrl: url(row.traceArtifactKey),
      checkpoints: results.map(
        (r): CheckpointView => ({
          name: r.name,
          reviewState: r.reviewState as ReviewState,
          captureMode: captureModes.get(r.name) ?? "element",
          resolution: r.resolution as Resolution | null,
          diffScore: r.diffScore,
          threshold: r.threshold,
          healed: r.healed,
          masks: masksByName.get(r.name) ?? [],
          actualUrl: url(r.actualArtifactKey),
          baselineUrl: url(r.baselineArtifactKey),
          diffUrl: url(r.diffArtifactKey),
        }),
      ),
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
   *  aggregate row + report, so one fan-out doesn't flood the flat list. */
  async listRuns(limit = 100): Promise<RunSummary[]> {
    const rows = await this.db
      .select({
        runId: runs.id,
        status: runs.status,
        environmentId: runs.environmentId,
        error: runs.error,
        createdAt: runs.createdAt,
        testName: tests.name,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .where(isNull(runs.suiteRunId))
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

    return rows.map(
      (r): RunSummary => ({
        runId: r.runId,
        testName: r.testName,
        environment: r.environmentId ? (envNames.get(r.environmentId) ?? ENVIRONMENT) : ENVIRONMENT,
        status: r.status,
        runTimestamp: r.createdAt.toISOString(),
        error: r.error,
      }),
    );
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

  /** Approve a checkpoint: promote a pending seed (or replace an active baseline) and audit it. */
  async approve(runId: string, checkpointName: string): Promise<{ ok: true }> {
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
        approvedBy: "system",
        approvedAt: new Date(),
      });
    } else if (result.reviewState === "diff") {
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
          approvedBy: "system",
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
      .set({ resolution: "approved" })
      .where(eq(runResults.id, result.id));
    return { ok: true };
  }

  /**
   * Bulk-approve every checkpoint in a run that still needs review
   * (`pending-baseline` | `diff`, undecided), in one audited operation. Each is
   * approved via the single-checkpoint path, so it seeds/replaces and audits its
   * baseline identically. Passing and already-decided checkpoints are left
   * untouched. Bulk reject is intentionally out of scope.
   */
  async approveAll(runId: string): Promise<{ approved: number }> {
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
      await this.approve(runId, c.name);
    }
    return { approved: candidates.length };
  }

  /** Reject a checkpoint: record a regression; the baseline is left untouched. */
  async reject(runId: string, checkpointName: string): Promise<{ ok: true }> {
    const [result] = await this.db
      .select({ id: runResults.id, resolution: runResults.resolution })
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
    await this.db
      .update(runResults)
      .set({ resolution: "rejected" })
      .where(eq(runResults.id, result.id));
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
    const { verdict, score, diffImage } = diffPng(baseline, actual, threshold, input.masks ?? []);
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
      createdBy: "system",
    });

    // 2. Re-judge ONLY this run_result against the stored artifacts.
    const threshold = input.threshold ?? ctx.threshold;
    const { verdict, score, diffImage } = diffPng(baseline, actual, threshold, masks);
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
