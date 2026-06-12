import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runResults, runs, testVersions } from "@varys/db";
import { type Boss, enqueueRun } from "@varys/queue";
import type { StorageAdapter } from "@varys/storage-adapter";
import { desc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { BOSS } from "../queue/queue.module";
import { STORAGE } from "../storage/storage.module";

export interface CreatedRun {
  runId: string;
}

export interface CheckpointView {
  name: string;
  status: string;
  artifactUrl: string | null;
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
        status: runResults.status,
        artifactKey: runResults.artifactKey,
      })
      .from(runResults)
      .where(eq(runResults.runId, runId));

    return {
      runId,
      status: row.status,
      checkpoints: results.map((r) => ({
        name: r.name,
        status: r.status,
        artifactUrl: r.artifactKey ? this.storage.getUrl(r.artifactKey) : null,
      })),
    };
  }
}
