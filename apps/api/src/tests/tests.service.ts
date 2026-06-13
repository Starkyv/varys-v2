import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { TestSummary } from "@varys/review-contract";
import { parseTestDefinition, type TestDefinition } from "@varys/step-schema";
import { asc, desc, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { folders, tests, testTags, testVersions } from "../db/schema";

/** Organization metadata only — `folderId: null` unfiles; `tags` REPLACES the whole
 *  list (add + remove in one write); absent fields are left untouched. Deliberately
 *  NOT the definition: an update here writes only organization rows and never creates
 *  a test_version (so baselines/review state can't be touched). */
export interface UpdateTestInput {
  name?: string;
  folderId?: string | null;
  tags?: string[];
}

/** Trim, drop empties, dedupe — a tag attaches at most once per test. */
function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

/**
 * Does a recording need an environment to run? True when it declares variables, or
 * (for recordings made before declared variables) its definition still carries an
 * unresolved `{{token}}` anywhere. The Run UI uses this to require an environment.
 */
function needsEnvironment(definition: TestDefinition): boolean {
  if (definition.variables && definition.variables.length > 0) return true;
  return JSON.stringify(definition).includes("{{");
}

export interface CreatedTest {
  id: string;
  version: number;
}

export interface TestView {
  id: string;
  name: string;
  version: number;
  definition: TestDefinition;
}

@Injectable()
export class TestsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(input: unknown): Promise<CreatedTest> {
    const definition = parseTestDefinition(input);
    const [created] = await this.db
      .insert(tests)
      .values({ name: definition.name })
      .returning({ id: tests.id });
    await this.db
      .insert(testVersions)
      .values({ testId: created.id, version: 1, definition });
    return { id: created.id, version: 1 };
  }

  /** All saved tests (recordings), newest first — each tagged with whether it needs
   *  an environment to run (from its latest version's definition) and its folder. */
  async list(): Promise<TestSummary[]> {
    // One row per test = its latest version (max version), via a correlated subquery.
    const rows = await this.db
      .select({
        id: tests.id,
        name: tests.name,
        createdAt: tests.createdAt,
        folderId: tests.folderId,
        folderName: folders.name,
        definition: testVersions.definition,
      })
      .from(tests)
      .innerJoin(testVersions, eq(testVersions.testId, tests.id))
      .leftJoin(folders, eq(folders.id, tests.folderId))
      .where(
        sql`${testVersions.version} = (select max(v.version) from test_versions v where v.test_id = ${tests.id})`,
      )
      .orderBy(desc(tests.createdAt));

    // Tags grouped per test (one extra query beats an array_agg group-by here).
    const tagRows = await this.db
      .select({ testId: testTags.testId, tag: testTags.tag })
      .from(testTags)
      .orderBy(asc(testTags.tag));
    const tagsByTest = new Map<string, string[]>();
    for (const t of tagRows) {
      const list = tagsByTest.get(t.testId) ?? [];
      list.push(t.tag);
      tagsByTest.set(t.testId, list);
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt.toISOString(),
      needsEnvironment: needsEnvironment(r.definition as TestDefinition),
      folderId: r.folderId,
      folderName: r.folderName,
      tags: tagsByTest.get(r.id) ?? [],
    }));
  }

  /** The distinct tags currently in use (alphabetical) — feeds pickers/filters. */
  async listTags(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ tag: testTags.tag })
      .from(testTags)
      .orderBy(asc(testTags.tag));
    return rows.map((r) => r.tag);
  }

  /** Rename, (un)file, and/or retag a test. Writes ONLY organization rows (tests +
   *  test_tags) — never a new test_version — so organize actions cannot perturb
   *  baselines or review state. Tags are a full-list replace, normalized. */
  async update(id: string, input: UpdateTestInput): Promise<{ ok: true }> {
    const patch: Partial<typeof tests.$inferInsert> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException("test name cannot be empty");
      patch.name = name;
    }
    if (input.folderId !== undefined) patch.folderId = input.folderId; // null = unfile
    const tags = input.tags !== undefined ? normalizeTags(input.tags) : undefined;
    if (Object.keys(patch).length === 0 && tags === undefined) return { ok: true };

    try {
      await this.db.transaction(async (tx) => {
        if (Object.keys(patch).length > 0) {
          const updated = await tx
            .update(tests)
            .set(patch)
            .where(eq(tests.id, id))
            .returning({ id: tests.id });
          if (updated.length === 0) throw new NotFoundException(`Test ${id} not found`);
        } else {
          const [exists] = await tx
            .select({ id: tests.id })
            .from(tests)
            .where(eq(tests.id, id))
            .limit(1);
          if (!exists) throw new NotFoundException(`Test ${id} not found`);
        }
        if (tags !== undefined) {
          // Full replace: one write covers adds and removals.
          await tx.delete(testTags).where(eq(testTags.testId, id));
          if (tags.length > 0) {
            await tx.insert(testTags).values(tags.map((tag) => ({ testId: id, tag })));
          }
        }
      });
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      // FK violation: the target folder doesn't exist.
      const code =
        (err as { code?: string; cause?: { code?: string } })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "23503") {
        throw new NotFoundException(`Folder ${input.folderId} not found`);
      }
      throw err;
    }
    return { ok: true };
  }

  async getById(id: string): Promise<TestView> {
    const [row] = await this.db
      .select({
        name: tests.name,
        version: testVersions.version,
        definition: testVersions.definition,
      })
      .from(testVersions)
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .where(eq(testVersions.testId, id))
      .orderBy(desc(testVersions.version))
      .limit(1);

    if (!row) throw new NotFoundException(`Test ${id} not found`);

    return {
      id,
      name: row.name,
      version: row.version,
      definition: row.definition as TestDefinition,
    };
  }
}
