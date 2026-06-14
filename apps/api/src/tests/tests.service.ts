import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  ConfigWait,
  EditableWait,
  TestConfigPatch,
  TestConfigStep,
  TestConfigView,
  TestSummary,
} from "@varys/review-contract";
import {
  describeStep,
  type Fingerprint,
  parseTestDefinition,
  type TestDefinition,
  type Wait,
} from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  baselines,
  folders,
  runResults,
  runs,
  runSteps,
  tests,
  testTags,
  testVersions,
} from "../db/schema";
import { STORAGE } from "../storage/storage.module";

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

/** A short human handle for a selector-wait's target fingerprint (display only). */
function waitTargetLabel(fp: Fingerprint): string {
  if (fp.testId) return `[data-testid="${fp.testId}"]`;
  if (fp.accessibleName) return `"${fp.accessibleName}"`;
  if (fp.text) return `"${fp.text}"`;
  if (fp.attributes?.id) return `#${fp.attributes.id}`;
  if (fp.role) return `<${fp.role}>`;
  return `<${fp.tag}>`;
}

/** Project a stored wait to the editor's read-model — selector targets become a label. */
function toConfigWait(w: Wait): ConfigWait {
  if (w.kind === "selector") {
    return {
      kind: "selector",
      state: w.state,
      ...(w.timeoutMs !== undefined ? { timeoutMs: w.timeoutMs } : {}),
      targetLabel: waitTargetLabel(w.target),
    };
  }
  return w; // delay / networkIdle are structurally identical to ConfigWait
}

/** Replace the authorable (delay/networkIdle) waits while preserving any selector waits
 *  the editor can't author — selectors keep their relative order, ahead of the new set. */
function mergeWaits(existing: Wait[] | undefined, editable: EditableWait[]): Wait[] {
  const preserved = (existing ?? []).filter((w) => w.kind === "selector");
  return [...preserved, ...editable];
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
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
  ) {}

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

  /**
   * The editable config surface of a test's LATEST version — the test-detail page's
   * read-model: the test-level default waits plus, per step, its label, the waits
   * before it, and (for screenshots) the threshold. A display projection only; the
   * full fingerprints/definition aren't surfaced (v1 edits waits + threshold).
   */
  async getConfig(id: string): Promise<TestConfigView> {
    const view = await this.getById(id); // latest version + definition (throws if none)
    const def = view.definition;
    return {
      id: view.id,
      name: view.name,
      version: view.version,
      defaults: (def.defaults?.waitBefore ?? []).map(toConfigWait),
      steps: def.steps.map((s, index): TestConfigStep => ({
        index,
        type: s.type,
        label: describeStep(s),
        supportsWaits: s.type !== "navigate",
        waitBefore: s.type === "navigate" ? [] : (s.waitBefore ?? []).map(toConfigWait),
        checkpointName: s.type === "screenshot" ? s.name : null,
        captureMode: s.type === "screenshot" ? (s.captureMode ?? "element") : null,
        threshold: s.type === "screenshot" ? (s.threshold ?? null) : null,
      })),
    };
  }

  /**
   * Apply a config patch (waits + threshold) onto the test's latest definition and
   * write a NEW audited test_version (latest+1, `createdBy: "user"`). Optimistic
   * concurrency: the patch's `baseVersion` must match the current latest, else 409 —
   * so a stale editor can't silently clobber a newer version. Selector waits the
   * editor can't author are preserved (it only replaces the delay/networkIdle ones).
   * The assembled definition is re-validated by the schema before it's stored.
   */
  async saveConfig(id: string, patch: TestConfigPatch): Promise<{ version: number }> {
    const [latest] = await this.db
      .select({ version: testVersions.version, definition: testVersions.definition })
      .from(testVersions)
      .where(eq(testVersions.testId, id))
      .orderBy(desc(testVersions.version))
      .limit(1);
    if (!latest) throw new NotFoundException(`Test ${id} not found`);
    if (patch.baseVersion !== latest.version) {
      throw new ConflictException(
        `Test was changed since you opened it (now at v${latest.version}). Reload and re-apply your edits.`,
      );
    }
    const def = latest.definition as TestDefinition;

    // Default waits: replace the authorable set, keep any (rare) selector defaults.
    const nextDefaults =
      patch.defaults !== undefined
        ? { waitBefore: mergeWaits(def.defaults?.waitBefore, patch.defaults) }
        : def.defaults;

    const stepPatch = new Map((patch.steps ?? []).map((p) => [p.index, p]));
    const nextSteps = def.steps.map((s, index) => {
      const p = stepPatch.get(index);
      if (!p || s.type === "navigate") return s; // navigate has no waits/threshold
      let out = s;
      if (p.waitBefore !== undefined) {
        out = { ...out, waitBefore: mergeWaits(out.waitBefore, p.waitBefore) };
      }
      if (p.threshold !== undefined && out.type === "screenshot") {
        out = { ...out, threshold: p.threshold };
      }
      return out;
    });

    const nextDefinition = {
      ...def,
      ...(nextDefaults !== undefined ? { defaults: nextDefaults } : {}),
      steps: nextSteps,
    };

    let validated: TestDefinition;
    try {
      validated = parseTestDefinition(nextDefinition);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "Invalid test configuration",
      );
    }

    const nextVersion = latest.version + 1;
    await this.db
      .insert(testVersions)
      .values({ testId: id, version: nextVersion, definition: validated, createdBy: "user" });
    return { version: nextVersion };
  }

  /**
   * Hard-delete a test and everything it owns — irreversible, no rollback. Removes
   * the runs' results + steps, the runs themselves, the test's baselines, every
   * test_version, then the test row (`test_tags` + `suite_tests` cascade in the DB).
   * These FK chains don't cascade, so they're deleted explicitly in dependency order
   * inside one transaction. Storage artifacts (screenshots, baselines, diffs, traces)
   * are purged best-effort afterwards — the DB delete is the source of truth, and an
   * orphaned blob is harmless whereas a dangling row is not.
   */
  async delete(id: string): Promise<{ ok: true }> {
    const [exists] = await this.db
      .select({ id: tests.id })
      .from(tests)
      .where(eq(tests.id, id))
      .limit(1);
    if (!exists) throw new NotFoundException(`Test ${id} not found`);

    // The test's versions → their runs (the non-cascading FK chain).
    const versionRows = await this.db
      .select({ id: testVersions.id })
      .from(testVersions)
      .where(eq(testVersions.testId, id));
    const versionIds = versionRows.map((v) => v.id);
    const runRows = versionIds.length
      ? await this.db.select({ id: runs.id }).from(runs).where(inArray(runs.testVersionId, versionIds))
      : [];
    const runIds = runRows.map((r) => r.id);

    // Gather artifact keys to purge BEFORE deleting the rows that reference them.
    const keys = new Set<string>();
    if (runIds.length) {
      const results = await this.db
        .select({
          actual: runResults.actualArtifactKey,
          baseline: runResults.baselineArtifactKey,
          diff: runResults.diffArtifactKey,
        })
        .from(runResults)
        .where(inArray(runResults.runId, runIds));
      for (const r of results) for (const k of [r.actual, r.baseline, r.diff]) if (k) keys.add(k);
      const traces = await this.db
        .select({ key: runs.traceArtifactKey })
        .from(runs)
        .where(inArray(runs.id, runIds));
      for (const r of traces) if (r.key) keys.add(r.key);
    }
    const baselineRows = await this.db
      .select({ key: baselines.artifactKey })
      .from(baselines)
      .where(eq(baselines.testId, id));
    for (const r of baselineRows) if (r.key) keys.add(r.key);

    await this.db.transaction(async (tx) => {
      if (runIds.length) {
        await tx.delete(runResults).where(inArray(runResults.runId, runIds));
        await tx.delete(runSteps).where(inArray(runSteps.runId, runIds));
        await tx.delete(runs).where(inArray(runs.id, runIds));
      }
      await tx.delete(baselines).where(eq(baselines.testId, id));
      await tx.delete(testVersions).where(eq(testVersions.testId, id));
      await tx.delete(tests).where(eq(tests.id, id)); // test_tags + suite_tests cascade
    });

    for (const key of keys) {
      await this.storage.delete(key).catch(() => undefined);
    }
    return { ok: true };
  }
}
