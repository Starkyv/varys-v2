import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { suites, suiteTests } from "@varys/db";
import type { SuiteSummary, SuiteView } from "@varys/review-contract";
import { asc, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { TestsService } from "../tests/tests.service";

/** `testIds` REPLACES the whole member list (one write covers adds and removals);
 *  absent fields are left untouched. A suite is pure organization metadata. */
export interface UpdateSuiteInput {
  name?: string;
  testIds?: string[];
}

/** Postgres error code, whether the driver error is thrown bare or wrapped. */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

@Injectable()
export class SuitesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TestsService) private readonly tests: TestsService,
  ) {}

  /** All suites (alphabetical) with how many tests each selects. */
  async list(): Promise<SuiteSummary[]> {
    return this.db
      .select({
        id: suites.id,
        name: suites.name,
        testCount: sql<number>`count(${suiteTests.testId})::int`,
      })
      .from(suites)
      .leftJoin(suiteTests, eq(suiteTests.suiteId, suites.id))
      .groupBy(suites.id, suites.name)
      .orderBy(asc(suites.name));
  }

  /** A suite with its member tests as full summaries (folder/tags/needsEnvironment
   *  context included), in the tests list's own order (newest first). */
  async getById(id: string): Promise<SuiteView> {
    const [suite] = await this.db
      .select({ id: suites.id, name: suites.name })
      .from(suites)
      .where(eq(suites.id, id))
      .limit(1);
    if (!suite) throw new NotFoundException(`Suite ${id} not found`);

    const members = await this.db
      .select({ testId: suiteTests.testId })
      .from(suiteTests)
      .where(eq(suiteTests.suiteId, id));
    const memberIds = new Set(members.map((m) => m.testId));

    const all = await this.tests.list();
    return { ...suite, tests: all.filter((t) => memberIds.has(t.id)) };
  }

  async create(input: { name: string; testIds?: string[] }): Promise<{ id: string }> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException("suite name cannot be empty");
    const testIds = [...new Set(input.testIds ?? [])];
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(suites).values({ name }).returning({ id: suites.id });
        if (testIds.length > 0) {
          await tx
            .insert(suiteTests)
            .values(testIds.map((testId) => ({ suiteId: row.id, testId })));
        }
        return { id: row.id };
      });
    } catch (err) {
      if (pgCode(err) === "23503") {
        throw new NotFoundException("a selected test does not exist");
      }
      throw err;
    }
  }

  /** Rename and/or replace the member list wholesale. */
  async update(id: string, input: UpdateSuiteInput): Promise<{ ok: true }> {
    const name = input.name !== undefined ? input.name.trim() : undefined;
    if (name === "") throw new BadRequestException("suite name cannot be empty");
    const testIds = input.testIds !== undefined ? [...new Set(input.testIds)] : undefined;
    if (name === undefined && testIds === undefined) return { ok: true };

    try {
      await this.db.transaction(async (tx) => {
        if (name !== undefined) {
          const updated = await tx
            .update(suites)
            .set({ name })
            .where(eq(suites.id, id))
            .returning({ id: suites.id });
          if (updated.length === 0) throw new NotFoundException(`Suite ${id} not found`);
        } else {
          const [exists] = await tx
            .select({ id: suites.id })
            .from(suites)
            .where(eq(suites.id, id))
            .limit(1);
          if (!exists) throw new NotFoundException(`Suite ${id} not found`);
        }
        if (testIds !== undefined) {
          // Full replace: one write covers adds and removals.
          await tx.delete(suiteTests).where(eq(suiteTests.suiteId, id));
          if (testIds.length > 0) {
            await tx
              .insert(suiteTests)
              .values(testIds.map((testId) => ({ suiteId: id, testId })));
          }
        }
      });
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      if (pgCode(err) === "23503") {
        throw new NotFoundException("a selected test does not exist");
      }
      throw err;
    }
    return { ok: true };
  }

  /** Delete a suite. Memberships go with it (CASCADE); member TESTS are untouched. */
  async delete(id: string): Promise<{ ok: true }> {
    const deleted = await this.db
      .delete(suites)
      .where(eq(suites.id, id))
      .returning({ id: suites.id });
    if (deleted.length === 0) throw new NotFoundException(`Suite ${id} not found`);
    return { ok: true };
  }
}
