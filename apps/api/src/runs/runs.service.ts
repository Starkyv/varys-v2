import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { baselines, runResults, runs, testVersions } from "@varys/db";
import { type Boss, enqueueRun } from "@varys/queue";
import type { TestDefinition } from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import { and, desc, eq } from "drizzle-orm";
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

/** Per-checkpoint review read-model — the contract the review UI consumes. */
export interface CheckpointView {
  name: string;
  reviewState: string;
  diffScore: number | null;
  threshold: number;
  healed: boolean;
  actualUrl: string | null;
  baselineUrl: string | null;
  diffUrl: string | null;
}

export interface RunView {
  runId: string;
  status: string;
  checkpoints: CheckpointView[];
}

@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: Boss,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
  ) {}

  async create(testId: string): Promise<CreatedRun> {
    const [version] = await this.db
      .select({ id: testVersions.id })
      .from(testVersions)
      .where(eq(testVersions.testId, testId))
      .orderBy(desc(testVersions.version))
      .limit(1);
    if (!version) throw new NotFoundException(`Test ${testId} not found`);

    const [run] = await this.db
      .insert(runs)
      .values({ testVersionId: version.id, status: "queued" })
      .returning({ id: runs.id });

    await enqueueRun(this.boss, run.id);
    return { runId: run.id };
  }

  async getById(runId: string): Promise<RunView> {
    const [row] = await this.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!row) throw new NotFoundException(`Run ${runId} not found`);

    const results = await this.db
      .select({
        name: runResults.checkpointName,
        reviewState: runResults.reviewState,
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

    return {
      runId,
      status: row.status,
      checkpoints: results.map((r) => ({
        name: r.name,
        reviewState: r.reviewState,
        diffScore: r.diffScore,
        threshold: r.threshold,
        healed: r.healed,
        actualUrl: url(r.actualArtifactKey),
        baselineUrl: url(r.baselineArtifactKey),
        diffUrl: url(r.diffArtifactKey),
      })),
    };
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
      .select({ testId: testVersions.testId, definition: testVersions.definition })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .where(eq(runs.id, runId))
      .limit(1);
    if (!ctx) throw new NotFoundException(`Run ${runId} not found`);
    const vpKey = viewportKey((ctx.definition as TestDefinition).viewport);

    if (result.reviewState === "pending-baseline") {
      if (!result.actualArtifactKey) {
        throw new BadRequestException("no actual artifact to promote");
      }
      await this.db.insert(baselines).values({
        testId: ctx.testId,
        checkpointName,
        environment: ENVIRONMENT,
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
            eq(baselines.environment, ENVIRONMENT),
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
}
