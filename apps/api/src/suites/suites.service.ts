import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { suiteFolders, suites, suiteTests } from "@varys/db";
import type { SuiteSummary, SuiteView, TestSummary } from "@varys/review-contract";
import { asc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { TestsService } from "../tests/tests.service";
import { folderChildren, subtreeOf, suiteSelection } from "./suite-membership";

/** `testIds` / `folderIds` each REPLACE their whole selection (one write covers adds and
 *  removals); absent fields are left untouched. A suite is pure organization metadata. */
export interface UpdateSuiteInput {
  name?: string;
  testIds?: string[];
  folderIds?: string[];
}

/** Postgres error code, whether the driver error is thrown bare or wrapped. */
function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

/** The effective, deduped test ids a suite selects: every test whose folder is in a selected
 *  folder's subtree, unioned with the individually-selected tests. */
function resolveEffective(
  allTests: TestSummary[],
  folderIds: string[],
  testIds: string[],
  children: Map<string, string[]>,
): Set<string> {
  const ids = new Set(testIds);
  if (folderIds.length > 0) {
    const subtree = subtreeOf(folderIds, children);
    for (const t of allTests) {
      if (t.folderId && subtree.has(t.folderId)) ids.add(t.id);
    }
  }
  return ids;
}

@Injectable()
export class SuitesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TestsService) private readonly tests: TestsService,
  ) {}

  /** All suites (alphabetical) with their effective test count + how many folders each includes. */
  async list(): Promise<SuiteSummary[]> {
    const [suiteRows, tRows, fRows, all, children] = await Promise.all([
      this.db
        .select({ id: suites.id, name: suites.name, createdBy: suites.createdBy })
        .from(suites)
        .orderBy(asc(suites.name)),
      this.db.select({ suiteId: suiteTests.suiteId, testId: suiteTests.testId }).from(suiteTests),
      this.db
        .select({ suiteId: suiteFolders.suiteId, folderId: suiteFolders.folderId })
        .from(suiteFolders),
      this.tests.list(),
      folderChildren(this.db),
    ]);

    const testsBySuite = new Map<string, string[]>();
    for (const r of tRows) testsBySuite.set(r.suiteId, [...(testsBySuite.get(r.suiteId) ?? []), r.testId]);
    const foldersBySuite = new Map<string, string[]>();
    for (const r of fRows)
      foldersBySuite.set(r.suiteId, [...(foldersBySuite.get(r.suiteId) ?? []), r.folderId]);

    return suiteRows.map((s) => {
      const folderIds = foldersBySuite.get(s.id) ?? [];
      const testIds = testsBySuite.get(s.id) ?? [];
      const effective = resolveEffective(all, folderIds, testIds, children);
      return {
        id: s.id,
        name: s.name,
        createdBy: s.createdBy,
        testCount: effective.size,
        folderCount: folderIds.length,
      };
    });
  }

  /** A suite with its effective member tests (full summaries) plus the raw folder/test selection. */
  async getById(id: string): Promise<SuiteView> {
    const [suite] = await this.db
      .select({ id: suites.id, name: suites.name, createdBy: suites.createdBy })
      .from(suites)
      .where(eq(suites.id, id))
      .limit(1);
    if (!suite) throw new NotFoundException(`Suite ${id} not found`);

    const { testIds, folderIds } = await suiteSelection(this.db, id);
    const all = await this.tests.list();
    const effective = resolveEffective(all, folderIds, testIds, await folderChildren(this.db));
    return {
      ...suite,
      folderIds,
      testIds,
      tests: all.filter((t) => effective.has(t.id)),
    };
  }

  async create(
    input: { name: string; testIds?: string[]; folderIds?: string[] },
    createdBy?: string,
  ): Promise<{ id: string }> {
    const name = input.name?.trim();
    if (!name) throw new BadRequestException("suite name cannot be empty");
    const testIds = [...new Set(input.testIds ?? [])];
    const folderIds = [...new Set(input.folderIds ?? [])];
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(suites)
          .values({ name, createdBy: createdBy ?? null })
          .returning({ id: suites.id });
        if (testIds.length > 0) {
          await tx.insert(suiteTests).values(testIds.map((testId) => ({ suiteId: row.id, testId })));
        }
        if (folderIds.length > 0) {
          await tx
            .insert(suiteFolders)
            .values(folderIds.map((folderId) => ({ suiteId: row.id, folderId })));
        }
        return { id: row.id };
      });
    } catch (err) {
      if (pgCode(err) === "23503") {
        throw new NotFoundException("a selected test or folder does not exist");
      }
      throw err;
    }
  }

  /** Rename and/or replace the test + folder selection wholesale. */
  async update(id: string, input: UpdateSuiteInput): Promise<{ ok: true }> {
    const name = input.name !== undefined ? input.name.trim() : undefined;
    if (name === "") throw new BadRequestException("suite name cannot be empty");
    const testIds = input.testIds !== undefined ? [...new Set(input.testIds)] : undefined;
    const folderIds = input.folderIds !== undefined ? [...new Set(input.folderIds)] : undefined;
    if (name === undefined && testIds === undefined && folderIds === undefined) return { ok: true };

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
          await tx.delete(suiteTests).where(eq(suiteTests.suiteId, id));
          if (testIds.length > 0) {
            await tx.insert(suiteTests).values(testIds.map((testId) => ({ suiteId: id, testId })));
          }
        }
        if (folderIds !== undefined) {
          await tx.delete(suiteFolders).where(eq(suiteFolders.suiteId, id));
          if (folderIds.length > 0) {
            await tx
              .insert(suiteFolders)
              .values(folderIds.map((folderId) => ({ suiteId: id, folderId })));
          }
        }
      });
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      if (pgCode(err) === "23503") {
        throw new NotFoundException("a selected test or folder does not exist");
      }
      throw err;
    }
    return { ok: true };
  }

  /** Delete a suite. Memberships go with it (CASCADE); member TESTS and folders are untouched. */
  async delete(id: string): Promise<{ ok: true }> {
    const deleted = await this.db
      .delete(suites)
      .where(eq(suites.id, id))
      .returning({ id: suites.id });
    if (deleted.length === 0) throw new NotFoundException(`Suite ${id} not found`);
    return { ok: true };
  }
}
