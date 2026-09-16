import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  AgentCheckpoint,
  AgentCheckpointDeleteImpact,
  AgentCheckpointInput,
  CreateAgentTestRequest,
} from "@varys/review-contract";
import type { TestDefinition } from "@varys/step-schema";
import { agentCheckpoints, baselines, tests, testVersions } from "@varys/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

/**
 * The viewport recorded on an Agent-Driven Test's stub version.
 *
 * It exists only so the one `test_versions` row is a structurally valid definition; Varys does
 * not drive the browser for this kind, so nothing honours it as a capture setting. The value is
 * still the ordinary desktop default rather than something obviously fake, because
 * `baselines.viewport_key` is derived from it and a baseline keyed off a nonsense viewport reads
 * as a bug to whoever finds it later.
 */
const STUB_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 } as const;

/** The transaction handle `db.transaction` hands its callback. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Postgres unique-violation. Raised by `agent_checkpoints_test_name_uniq`. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

/**
 * Authoring for **Agent-Driven Tests** — the kind with no steps and no fingerprints.
 *
 * Two properties shape everything here:
 *
 * **Unversioned.** Instructions and checkpoints are edited in place and never write a
 * `test_version`. Iterating on the wording of a prompt is not an audit event. The single version
 * row exists only because `runs.test_version_id` is `NOT NULL`, so every run still has something
 * to hang off and no join, dashboard or report needs to know this kind is different.
 *
 * **Identity is the row id, not the name.** `baselines` is keyed by `checkpoint_name`, so a
 * rename would orphan every approved baseline for that slot. Because the checkpoint carries a
 * durable id, a rename can move the baselines with it instead — renaming for clarity costs
 * nothing, which is the only way authors will actually do it.
 */
@Injectable()
export class AgentTestsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Create an Agent-Driven Test a PERSON wrote: active immediately, `origin: "human"`, no Draft
   * and no Promote.
   *
   * Draft exists to gate an artifact a MACHINE wrote before a human trusts it. Here a person
   * types every word — the instructions, each checkpoint's name, how to reach it, what to accept
   * — so there is nothing generated to review and Promote would be a gate on nothing. The gate
   * that does the work for this kind is baseline approval, which is per-environment and already
   * exists.
   */
  async create(input: CreateAgentTestRequest, createdBy?: string): Promise<{ id: string; version: number }> {
    return await this.insert(input, { status: "active", origin: "human", createdBy });
  }

  /**
   * Create an Agent-Driven Test **Claude** wrote: a Draft, `origin: "ai"`, awaiting a human's
   * Promote — the mirror of {@link create} and the reason Draft returns for this kind.
   *
   * The gate is back because the premise that removed it is no longer true: a machine now writes
   * the artifact. Draft also earns a second job it did not have on the pinned path — it is the
   * only status the MCP authoring tools may write to, so promoting a test is what puts it beyond
   * their reach.
   *
   * `instructions` is the AI Instructions Claude AUTHORED, not the steering prompt that asked for
   * them. The two must not be confused: this slot is composed into every future run, so the
   * request ("make me a test for the dashboard") landing here would become standing orders.
   */
  async createDraft(
    input: CreateAgentTestRequest,
    createdBy?: string,
  ): Promise<{ id: string; version: number }> {
    return await this.insert(input, { status: "draft", origin: "ai", createdBy });
  }

  private async insert(
    input: CreateAgentTestRequest,
    opts: { status: "active" | "draft"; origin: "human" | "ai"; createdBy?: string },
  ): Promise<{ id: string; version: number }> {
    const name = input?.name?.trim();
    if (!name) throw new BadRequestException("test name cannot be empty");
    const instructions = input.instructions?.trim() || null;

    return await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(tests)
        .values({
          name,
          kind: "agent",
          status: opts.status,
          origin: opts.origin,
          intent: instructions,
          createdBy: opts.createdBy ?? null,
        })
        .returning({ id: tests.id });

      // The one and only version row, written here and never again. Deliberately assembled
      // rather than parsed: `testDefinition` requires at least one step, and an Agent-Driven
      // Test has none by definition. Nothing replays this — it is a placeholder that keeps the
      // run→version foreign key intact.
      const definition = { name, viewport: { ...STUB_VIEWPORT }, steps: [] } as unknown as TestDefinition;
      await tx.insert(testVersions).values({ testId: created.id, version: 1, definition });

      return { id: created.id, version: 1 };
    });
  }

  /** The test's Checkpoints in journey order. Throws if the test is not agent-driven. */
  async listCheckpoints(testId: string): Promise<AgentCheckpoint[]> {
    await this.assertAgentTest(testId);
    return await this.readCheckpoints(testId);
  }

  /** Append a Checkpoint to the end of the journey. */
  async addCheckpoint(testId: string, input: AgentCheckpointInput): Promise<AgentCheckpoint> {
    await this.assertAgentTest(testId);
    const name = input?.name?.trim();
    if (!name) throw new BadRequestException("checkpoint name cannot be empty");

    const existing = await this.readCheckpoints(testId);
    const position = existing.length ? existing[existing.length - 1].position + 1 : 0;

    try {
      const [row] = await this.db
        .insert(agentCheckpoints)
        .values({
          testId,
          position,
          name,
          instructions: input.instructions?.trim() ?? "",
          comparePrompt: input.comparePrompt?.trim() ?? "",
        })
        .returning();
      return toCheckpoint(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`This test already has a checkpoint named "${name}"`);
      }
      throw err;
    }
  }

  /**
   * Edit one Checkpoint. Omitted fields are unchanged.
   *
   * A rename **carries the checkpoint's approved baselines** in every environment, in the same
   * transaction as the rename itself. Half of this applied would leave a slot whose baselines
   * belong to a name that no longer exists, which is exactly the orphaning the row id exists to
   * prevent.
   */
  async updateCheckpoint(
    testId: string,
    checkpointId: string,
    input: AgentCheckpointInput,
  ): Promise<AgentCheckpoint> {
    await this.assertAgentTest(testId);
    const current = await this.readCheckpoint(testId, checkpointId);

    const patch: Partial<typeof agentCheckpoints.$inferInsert> = {};
    let renameFrom: string | null = null;
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException("checkpoint name cannot be empty");
      if (name !== current.name) {
        patch.name = name;
        renameFrom = current.name;
      }
    }
    if (input.instructions !== undefined) patch.instructions = input.instructions.trim();
    if (input.comparePrompt !== undefined) patch.comparePrompt = input.comparePrompt.trim();
    if (Object.keys(patch).length === 0) return current;
    patch.updatedAt = new Date();

    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(agentCheckpoints)
          .set(patch)
          .where(eq(agentCheckpoints.id, checkpointId))
          .returning();
        if (renameFrom && patch.name) {
          await tx
            .update(baselines)
            .set({ checkpointName: patch.name, updatedAt: new Date() })
            .where(and(eq(baselines.testId, testId), eq(baselines.checkpointName, renameFrom)));
        }
        return toCheckpoint(row);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`This test already has a checkpoint named "${input.name?.trim()}"`);
      }
      throw err;
    }
  }

  /**
   * What deleting this Checkpoint would cost — asked BEFORE the delete, so the author decides
   * knowing the answer. Dropping a slot drops its approved baselines in every environment, and
   * finding that out afterwards is how people stop trusting the editor.
   */
  async deleteImpact(testId: string, checkpointId: string): Promise<AgentCheckpointDeleteImpact> {
    await this.assertAgentTest(testId);
    const cp = await this.readCheckpoint(testId, checkpointId);
    const rows = await this.db
      .select({ environment: baselines.environment })
      .from(baselines)
      .where(and(eq(baselines.testId, testId), eq(baselines.checkpointName, cp.name)));
    return {
      checkpointName: cp.name,
      environments: [...new Set(rows.map((r) => r.environment))].sort(),
      baselineCount: rows.length,
    };
  }

  /**
   * Delete a Checkpoint, drop its baselines, and close the gap in the journey order.
   *
   * The baselines go because {@link deleteImpact} promised the author they would. Leaving them
   * behind would orphan rows nothing can ever reach again — and worse, a later checkpoint renamed
   * onto the dead name would collide with them on `baselines`' own unique key, failing for a
   * reason with no visible cause.
   */
  async deleteCheckpoint(testId: string, checkpointId: string): Promise<{ ok: true }> {
    await this.assertAgentTest(testId);
    const cp = await this.readCheckpoint(testId, checkpointId);
    await this.db.transaction(async (tx) => {
      await tx.delete(agentCheckpoints).where(eq(agentCheckpoints.id, checkpointId));
      await tx
        .delete(baselines)
        .where(and(eq(baselines.testId, testId), eq(baselines.checkpointName, cp.name)));
      const remaining = await tx
        .select({ id: agentCheckpoints.id })
        .from(agentCheckpoints)
        .where(eq(agentCheckpoints.testId, testId))
        .orderBy(asc(agentCheckpoints.position));
      await renumber(tx, remaining.map((r) => r.id));
    });
    return { ok: true };
  }

  /**
   * Reorder the whole journey in one write.
   *
   * The request must name EVERY checkpoint exactly once: the rows are cumulative, so a partial
   * reorder would silently rewrite what each later instruction can assume about the page.
   */
  async reorder(testId: string, ids: string[]): Promise<AgentCheckpoint[]> {
    await this.assertAgentTest(testId);
    const existing = await this.readCheckpoints(testId);
    const given = [...new Set(ids ?? [])];
    if (given.length !== ids?.length) throw new BadRequestException("reorder listed a checkpoint twice");
    if (given.length !== existing.length || !given.every((id) => existing.some((c) => c.id === id))) {
      throw new BadRequestException(
        "reorder must list every checkpoint of this test exactly once — the journey is cumulative",
      );
    }
    await this.db.transaction(async (tx) => renumber(tx, given));
    return await this.readCheckpoints(testId);
  }

  /**
   * Refuse a suite or schedule that would include an Agent-Driven Test.
   *
   * Nothing can run one unattended: Varys hosts no browser for this kind and holds no credential
   * that could summon anyone's Claude, so a nightly suite containing one would simply never fire
   * that member. A refusal is strictly better than a suite that silently reports on fewer tests
   * than it lists.
   */
  async assertNoAgentTests(testIds: string[], context: "suite" | "schedule"): Promise<void> {
    if (!testIds.length) return;
    const rows = await this.db
      .select({ id: tests.id, name: tests.name })
      .from(tests)
      .where(and(inArray(tests.id, testIds), eq(tests.kind, "agent")));
    if (!rows.length) return;
    const names = rows.map((r) => `"${r.name}"`).join(", ");
    throw new BadRequestException(
      `${names} ${rows.length === 1 ? "is an Agent-Driven Test and" : "are Agent-Driven Tests and"} cannot join a ${context}: it runs on your own local Claude, so there is nothing to run it unattended.`,
    );
  }

  private async assertAgentTest(testId: string): Promise<void> {
    const [row] = await this.db
      .select({ kind: tests.kind })
      .from(tests)
      .where(eq(tests.id, testId))
      .limit(1);
    if (!row) throw new NotFoundException(`Test ${testId} not found`);
    if (row.kind !== "agent") {
      throw new BadRequestException("This test is pinned — its checkpoints live in its recorded steps");
    }
  }

  private async readCheckpoints(testId: string): Promise<AgentCheckpoint[]> {
    const rows = await this.db
      .select()
      .from(agentCheckpoints)
      .where(eq(agentCheckpoints.testId, testId))
      .orderBy(asc(agentCheckpoints.position));
    return rows.map(toCheckpoint);
  }

  private async readCheckpoint(testId: string, checkpointId: string): Promise<AgentCheckpoint> {
    const [row] = await this.db
      .select()
      .from(agentCheckpoints)
      .where(and(eq(agentCheckpoints.id, checkpointId), eq(agentCheckpoints.testId, testId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Checkpoint ${checkpointId} not found on test ${testId}`);
    return toCheckpoint(row);
  }
}

function toCheckpoint(row: typeof agentCheckpoints.$inferSelect): AgentCheckpoint {
  return {
    id: row.id,
    position: row.position,
    name: row.name,
    instructions: row.instructions,
    comparePrompt: row.comparePrompt,
  };
}

/**
 * Rewrite positions to 0..n-1 in the given order.
 *
 * A single pass is safe: `(test_id, position)` is a plain index, not a unique constraint, so two
 * rows may briefly share a position mid-transaction. Only `(test_id, name)` is unique, and that
 * is the one the Checkpoint Manifest actually depends on.
 */
async function renumber(tx: Tx, orderedIds: string[]): Promise<void> {
  for (const [i, id] of orderedIds.entries()) {
    await tx
      .update(agentCheckpoints)
      .set({ position: i, updatedAt: new Date() })
      .where(eq(agentCheckpoints.id, id));
  }
}
