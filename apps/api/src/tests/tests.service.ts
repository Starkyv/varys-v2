import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  CaptureMode,
  ConfigWait,
  DraftCheckpointPreview,
  DraftSummary,
  DraftView,
  EditableWait,
  PromoteDraftBody,
  TestConfigPatch,
  TestConfigStep,
  TestConfigView,
  TestOrigin,
  TestSchedule,
  TestScheduleInput,
  TestScheduleSummary,
  TestStatus,
  TestSummary,
  TestVariable,
} from "@varys/review-contract";
import {
  describeStep,
  type Fingerprint,
  parseTestDefinition,
  type Step,
  type TestDefinition,
  type Wait,
} from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import parser from "cron-parser";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  baselines,
  draftPreviews,
  environments,
  folders,
  runResults,
  runs,
  runSteps,
  tests,
  testSchedules,
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
  /** Set/replace the cron schedule, or `null` to clear it (Slice 8). Omit to leave
   *  unchanged. Setting a schedule never writes a new test_version. */
  schedule?: TestScheduleInput | null;
}

/**
 * Validate a cron expression in a timezone and return its next fire time, or null when
 * the schedule is disabled (nothing to fire). Throws `BadRequestException` on an
 * unparseable cron / unknown timezone — the editor's save-time guard. Used at config time
 * here and after each fire by the scheduler (PRD 1, Issue 2).
 */
function nextCronRun(cron: string, timezone: string, enabled: boolean): Date | null {
  let next: Date;
  try {
    next = parser.parseExpression(cron, { tz: timezone }).next().toDate();
  } catch (err) {
    throw new BadRequestException(
      `Invalid cron schedule: ${err instanceof Error ? err.message : "could not parse expression"}`,
    );
  }
  return enabled ? next : null;
}

/** Trim, drop empties, dedupe — a tag attaches at most once per test. */
function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

/**
 * Every variable a recording references, as `{name, kind}` — the exact set the worker's
 * resolver must fill from the chosen environment, so the Run UI can flag a missing value
 * up front instead of failing mid-run with "unresolved variable". Seeded from the
 * declared `variables` (kinds the recorder assigned), then unioned with a scan of the
 * WHOLE definition for `{{token}}`s — navigate urls, typed values, AND selector-bound
 * fingerprint text, which `variablesFromSteps` (declared `variables`) doesn't cover but
 * the resolver still tries to fill. Also recovers variables for recordings made before
 * declared `variables` existed. `{{secret:x}}` → secret; `{{baseUrl}}` → url; else data.
 * Deduped by name, first-seen order.
 */
function definitionVariables(definition: TestDefinition): TestVariable[] {
  const seen = new Map<string, TestVariable>(
    (definition.variables ?? []).map((v) => [v.name, v]),
  );
  const re = /\{\{\s*(secret:)?([\w.-]+)\s*\}\}/g;
  const json = JSON.stringify(definition);
  for (let m = re.exec(json); m; m = re.exec(json)) {
    const name = m[2];
    if (seen.has(name)) continue;
    const kind: TestVariable["kind"] = m[1] ? "secret" : name === "baseUrl" ? "url" : "data";
    seen.set(name, { name, kind });
  }
  return [...seen.values()];
}

/** How many checkpoints (screenshot steps) a definition asserts — 0 ⇒ a no-op test. */
function checkpointCount(definition: TestDefinition): number {
  return definition.steps.filter((s) => s.type === "screenshot").length;
}

/** The definition's screenshot (checkpoint) steps, narrowed. */
function screenshotSteps(definition: TestDefinition): Extract<Step, { type: "screenshot" }>[] {
  return definition.steps.filter(
    (s): s is Extract<Step, { type: "screenshot" }> => s.type === "screenshot",
  );
}

/** Deterministic storage key for a draft checkpoint's authoring-preview screenshot. */
function previewKey(testId: string, checkpointName: string): string {
  const safe = checkpointName.replace(/[^\w.-]+/g, "_") || "checkpoint";
  return `drafts/${testId}/${safe}/preview.png`;
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

  /** All ACTIVE tests (recordings), newest first — each tagged with whether it needs
   *  an environment to run (from its latest version's definition) and its folder.
   *  Un-promoted AI drafts are excluded — they live in the review queue (`listDrafts`)
   *  and are not suite/schedule eligible. */
  async list(): Promise<TestSummary[]> {
    // One row per test = its latest version (max version), via a correlated subquery.
    const rows = await this.db
      .select({
        id: tests.id,
        name: tests.name,
        createdAt: tests.createdAt,
        status: tests.status,
        origin: tests.origin,
        folderId: tests.folderId,
        folderName: folders.name,
        definition: testVersions.definition,
        scheduleCron: testSchedules.cron,
        scheduleEnabled: testSchedules.enabled,
        scheduleNextRunAt: testSchedules.nextRunAt,
      })
      .from(tests)
      .innerJoin(testVersions, eq(testVersions.testId, tests.id))
      .leftJoin(folders, eq(folders.id, tests.folderId))
      .leftJoin(testSchedules, eq(testSchedules.testId, tests.id))
      .where(
        sql`${tests.status} = 'active' and ${testVersions.version} = (select max(v.version) from test_versions v where v.test_id = ${tests.id})`,
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

    return rows.map((r) => {
      const variables = definitionVariables(r.definition as TestDefinition);
      return {
        id: r.id,
        name: r.name,
        createdAt: r.createdAt.toISOString(),
        status: r.status as TestStatus,
        origin: r.origin as TestOrigin,
        // A recording needs an environment iff it references any variable/secret.
        needsEnvironment: variables.length > 0,
        variables,
        folderId: r.folderId,
        folderName: r.folderName,
        tags: tagsByTest.get(r.id) ?? [],
        schedule: r.scheduleCron
          ? ({
              enabled: r.scheduleEnabled ?? false,
              cron: r.scheduleCron,
              nextRunAt: r.scheduleNextRunAt ? r.scheduleNextRunAt.toISOString() : null,
            } satisfies TestScheduleSummary)
          : null,
      };
    });
  }

  /**
   * Persist an AI-authored definition as a Draft (`status: "draft"`, `origin: "ai"`):
   * a first-class test (full definition, individually runnable for baseline preview)
   * but held out of suites/schedules and surfaced in the review queue until a human
   * promotes it. Mirrors `create`, plus the draft flags + steering `intent`.
   */
  async createDraft(
    input: unknown,
    opts?: { intent?: string | null; previews?: { checkpointName: string; bytes: Buffer }[] },
  ): Promise<CreatedTest> {
    const definition = parseTestDefinition(input);
    const [created] = await this.db
      .insert(tests)
      .values({
        name: definition.name,
        status: "draft",
        origin: "ai",
        intent: opts?.intent ?? null,
      })
      .returning({ id: tests.id });
    await this.db
      .insert(testVersions)
      .values({ testId: created.id, version: 1, definition });

    // Authoring-preview screenshots: reference images of what Claude saw at each
    // checkpoint (DESIGN §4 — NOT the golden baseline; the runner seeds that on replay).
    for (const p of opts?.previews ?? []) {
      const key = previewKey(created.id, p.checkpointName);
      await this.storage.put(key, p.bytes);
      await this.db
        .insert(draftPreviews)
        .values({ testId: created.id, checkpointName: p.checkpointName, artifactKey: key });
    }
    return { id: created.id, version: 1 };
  }

  /** The AI-authored Draft review queue, newest first — each draft's checkpoint count
   *  (from its latest definition) and steering intent, so a reviewer can triage and open it. */
  async listDrafts(): Promise<DraftSummary[]> {
    const rows = await this.db
      .select({
        id: tests.id,
        name: tests.name,
        origin: tests.origin,
        intent: tests.intent,
        createdAt: tests.createdAt,
        definition: testVersions.definition,
      })
      .from(tests)
      .innerJoin(testVersions, eq(testVersions.testId, tests.id))
      .where(
        sql`${tests.status} = 'draft' and ${testVersions.version} = (select max(v.version) from test_versions v where v.test_id = ${tests.id})`,
      )
      .orderBy(desc(tests.createdAt));

    // Representative thumbnail per draft = its first checkpoint's authoring preview.
    const ids = rows.map((r) => r.id);
    const previewRows = ids.length
      ? await this.db
          .select({
            testId: draftPreviews.testId,
            checkpointName: draftPreviews.checkpointName,
            artifactKey: draftPreviews.artifactKey,
          })
          .from(draftPreviews)
          .where(inArray(draftPreviews.testId, ids))
      : [];
    const keyByTestCheckpoint = new Map<string, Map<string, string>>();
    for (const p of previewRows) {
      const m = keyByTestCheckpoint.get(p.testId) ?? new Map<string, string>();
      m.set(p.checkpointName, p.artifactKey);
      keyByTestCheckpoint.set(p.testId, m);
    }

    return rows.map((r) => {
      const def = r.definition as TestDefinition;
      const firstCp = screenshotSteps(def)[0]?.name;
      const key = firstCp ? keyByTestCheckpoint.get(r.id)?.get(firstCp) : undefined;
      return {
        id: r.id,
        name: r.name,
        origin: r.origin as TestOrigin,
        createdAt: r.createdAt.toISOString(),
        checkpointCount: checkpointCount(def),
        intent: r.intent,
        previewUrl: key ? this.storage.getUrl(key) : null,
      };
    });
  }

  /** Full draft detail — the summary plus every checkpoint's authoring-preview screenshot,
   *  for the promote dialog's "what this test asserts" gallery. */
  async getDraft(id: string): Promise<DraftView> {
    const [row] = await this.db
      .select({
        name: tests.name,
        origin: tests.origin,
        intent: tests.intent,
        createdAt: tests.createdAt,
        definition: testVersions.definition,
      })
      .from(tests)
      .innerJoin(testVersions, eq(testVersions.testId, tests.id))
      .where(eq(tests.id, id))
      .orderBy(desc(testVersions.version))
      .limit(1);
    if (!row) throw new NotFoundException(`Draft ${id} not found`);

    const previewRows = await this.db
      .select({ checkpointName: draftPreviews.checkpointName, artifactKey: draftPreviews.artifactKey })
      .from(draftPreviews)
      .where(eq(draftPreviews.testId, id));
    const keyByName = new Map(previewRows.map((p) => [p.checkpointName, p.artifactKey]));

    const checkpoints: DraftCheckpointPreview[] = screenshotSteps(row.definition as TestDefinition).map(
      (s) => {
        const key = keyByName.get(s.name);
        return {
          name: s.name,
          captureMode: (s.captureMode ?? "element") as CaptureMode,
          previewUrl: key ? this.storage.getUrl(key) : null,
        };
      },
    );

    return {
      id,
      name: row.name,
      origin: row.origin as TestOrigin,
      createdAt: row.createdAt.toISOString(),
      intent: row.intent,
      checkpoints,
    };
  }

  /**
   * Promote a Draft into the active corpus: assign a folder + tags and flip
   * `status: "active"` so it becomes suite/schedule eligible. The one human gate on AI
   * output — web-UI only; never an agent tool. Baseline approval stays the separate
   * per-environment gate (this does not touch baselines or write a test_version).
   * 409 if the test is already active (only a draft can be promoted).
   */
  async promote(id: string, body: PromoteDraftBody): Promise<{ ok: true }> {
    const tags = body.tags !== undefined ? normalizeTags(body.tags) : undefined;
    try {
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ status: tests.status })
          .from(tests)
          .where(eq(tests.id, id))
          .limit(1);
        if (!row) throw new NotFoundException(`Test ${id} not found`);
        if (row.status !== "draft") {
          throw new ConflictException(`Test ${id} is not a draft (already promoted)`);
        }
        await tx
          .update(tests)
          .set({ status: "active", folderId: body.folderId ?? null })
          .where(eq(tests.id, id));
        if (tags !== undefined) {
          await tx.delete(testTags).where(eq(testTags.testId, id));
          if (tags.length > 0) {
            await tx.insert(testTags).values(tags.map((tag) => ({ testId: id, tag })));
          }
        }
      });
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof ConflictException) throw err;
      const code =
        (err as { code?: string; cause?: { code?: string } })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "23503") throw new NotFoundException(`Folder ${body.folderId} not found`);
      throw err;
    }
    return { ok: true };
  }

  /** The distinct tags currently in use (alphabetical) — feeds pickers/filters. */
  async listTags(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ tag: testTags.tag })
      .from(testTags)
      .orderBy(asc(testTags.tag));
    return rows.map((r) => r.tag);
  }

  /** Rename, (un)file, retag, and/or (re)schedule a test. Writes ONLY relational rows
   *  (tests + test_tags + test_schedules) — never a new test_version — so these actions
   *  cannot perturb baselines or review state. Tags are a full-list replace, normalized;
   *  `schedule: null` clears the cron, a value upserts it. `actor` is recorded as the
   *  schedule's owner (attributed to its unattended runs, §11 audit). */
  async update(id: string, input: UpdateTestInput, actor?: string): Promise<{ ok: true }> {
    const patch: Partial<typeof tests.$inferInsert> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestException("test name cannot be empty");
      patch.name = name;
    }
    if (input.folderId !== undefined) patch.folderId = input.folderId; // null = unfile
    const tags = input.tags !== undefined ? normalizeTags(input.tags) : undefined;
    const hasSchedule = input.schedule !== undefined;
    if (Object.keys(patch).length === 0 && tags === undefined && !hasSchedule) return { ok: true };

    // Validate + assemble the schedule BEFORE any write (fail fast): an unparseable cron
    // is a 400, an unknown environment a 404 — neither leaves a half-applied update.
    // `undefined` = leave as-is, `null` = clear, a row = upsert.
    let scheduleRow: typeof testSchedules.$inferInsert | null | undefined;
    if (input.schedule === null) {
      scheduleRow = null;
    } else if (input.schedule) {
      const s = input.schedule;
      const cron = s.cron?.trim();
      if (!cron) throw new BadRequestException("a schedule requires a cron expression");
      const timezone = s.timezone?.trim() || "UTC";
      const enabled = s.enabled ?? true;
      const nextRunAt = nextCronRun(cron, timezone, enabled); // throws 400 on bad cron/tz
      const environmentId = s.environmentId ?? null;
      if (environmentId) {
        const [env] = await this.db
          .select({ id: environments.id })
          .from(environments)
          .where(eq(environments.id, environmentId))
          .limit(1);
        if (!env) throw new NotFoundException(`Environment ${environmentId} not found`);
      }
      scheduleRow = {
        testId: id,
        cron,
        timezone,
        enabled,
        environmentId,
        keepTrace: s.keepTrace ?? false,
        nextRunAt,
        createdBy: actor ?? null,
        updatedAt: new Date(),
      };
    }

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
        if (scheduleRow === null) {
          await tx.delete(testSchedules).where(eq(testSchedules.testId, id));
        } else if (scheduleRow) {
          await tx
            .insert(testSchedules)
            .values(scheduleRow)
            .onConflictDoUpdate({
              target: testSchedules.testId,
              set: {
                cron: scheduleRow.cron,
                timezone: scheduleRow.timezone,
                enabled: scheduleRow.enabled,
                environmentId: scheduleRow.environmentId,
                keepTrace: scheduleRow.keepTrace,
                nextRunAt: scheduleRow.nextRunAt,
                createdBy: scheduleRow.createdBy,
                updatedAt: scheduleRow.updatedAt,
              },
            });
        }
      });
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof BadRequestException) throw err;
      // FK violation: the target folder doesn't exist (env was validated up front).
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
    const schedule = await this.readSchedule(id);
    return {
      id: view.id,
      name: view.name,
      version: view.version,
      schedule,
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

  /** A test's cron schedule (with its environment name resolved) for the config view;
   *  null when the test is unscheduled. `nextRunAt`/`lastRunAt` are ISO or null. */
  private async readSchedule(testId: string): Promise<TestSchedule | null> {
    const [row] = await this.db
      .select({
        cron: testSchedules.cron,
        timezone: testSchedules.timezone,
        enabled: testSchedules.enabled,
        environmentId: testSchedules.environmentId,
        environmentName: environments.name,
        keepTrace: testSchedules.keepTrace,
        nextRunAt: testSchedules.nextRunAt,
        lastRunAt: testSchedules.lastRunAt,
        lastRunId: testSchedules.lastRunId,
      })
      .from(testSchedules)
      .leftJoin(environments, eq(environments.id, testSchedules.environmentId))
      .where(eq(testSchedules.testId, testId))
      .limit(1);
    if (!row) return null;
    return {
      cron: row.cron,
      timezone: row.timezone,
      enabled: row.enabled,
      environmentId: row.environmentId,
      environmentName: row.environmentName ?? null,
      keepTrace: row.keepTrace,
      nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      lastRunId: row.lastRunId,
    };
  }

  /**
   * Apply a config patch (waits + threshold) onto the test's latest definition and
   * write a NEW audited test_version (latest+1, `createdBy` = the editing user). Optimistic
   * concurrency: the patch's `baseVersion` must match the current latest, else 409 —
   * so a stale editor can't silently clobber a newer version. Selector waits the
   * editor can't author are preserved (it only replaces the delay/networkIdle ones).
   * The assembled definition is re-validated by the schema before it's stored.
   */
  async saveConfig(
    id: string,
    patch: TestConfigPatch,
    createdBy: string,
  ): Promise<{ version: number }> {
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

    // Removals are keyed by the SAME original index as edits. The entry navigation
    // (index 0) is the test's start URL → {{baseUrl}} and can't be removed, else replay
    // has nowhere to begin. Other steps (incl. mid-session navigates) may go.
    const removed = new Set((patch.steps ?? []).filter((p) => p.remove).map((p) => p.index));
    if (removed.has(0)) {
      throw new BadRequestException("The entry navigation step can't be removed.");
    }

    const nextSteps = def.steps
      .map((s, index) => {
        const p = stepPatch.get(index);
        // Removals are applied in the filter below; navigate has no waits/threshold.
        if (!p || p.remove || s.type === "navigate") return s;
        let out = s;
        if (p.waitBefore !== undefined) {
          out = { ...out, waitBefore: mergeWaits(out.waitBefore, p.waitBefore) };
        }
        if (p.threshold !== undefined && out.type === "screenshot") {
          out = { ...out, threshold: p.threshold };
        }
        return out;
      })
      .filter((_s, index) => !removed.has(index));

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
      .values({ testId: id, version: nextVersion, definition: validated, createdBy });
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
    const previewRows = await this.db
      .select({ key: draftPreviews.artifactKey })
      .from(draftPreviews)
      .where(eq(draftPreviews.testId, id));
    for (const r of previewRows) if (r.key) keys.add(r.key);

    await this.db.transaction(async (tx) => {
      if (runIds.length) {
        await tx.delete(runResults).where(inArray(runResults.runId, runIds));
        await tx.delete(runSteps).where(inArray(runSteps.runId, runIds));
        await tx.delete(runs).where(inArray(runs.id, runIds));
      }
      await tx.delete(baselines).where(eq(baselines.testId, id));
      await tx.delete(draftPreviews).where(eq(draftPreviews.testId, id));
      await tx.delete(testVersions).where(eq(testVersions.testId, id));
      await tx.delete(tests).where(eq(tests.id, id)); // test_tags + suite_tests cascade
    });

    for (const key of keys) {
      await this.storage.delete(key).catch(() => undefined);
    }
    return { ok: true };
  }
}
