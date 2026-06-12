import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TestSummary } from "@varys/review-contract";
import { parseTestDefinition, type TestDefinition } from "@varys/step-schema";
import { desc, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { tests, testVersions } from "../db/schema";

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
   *  an environment to run (from its latest version's definition). */
  async list(): Promise<TestSummary[]> {
    // One row per test = its latest version (max version), via a correlated subquery.
    const rows = await this.db
      .select({
        id: tests.id,
        name: tests.name,
        createdAt: tests.createdAt,
        definition: testVersions.definition,
      })
      .from(tests)
      .innerJoin(testVersions, eq(testVersions.testId, tests.id))
      .where(
        sql`${testVersions.version} = (select max(v.version) from test_versions v where v.test_id = ${tests.id})`,
      )
      .orderBy(desc(tests.createdAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt.toISOString(),
      needsEnvironment: needsEnvironment(r.definition as TestDefinition),
    }));
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
