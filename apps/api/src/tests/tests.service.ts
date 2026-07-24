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
  NewStepInput,
  PromoteDraftBody,
  Rect,
  TestConfigPatch,
  TestConfigStep,
  TestConfigView,
  TestOrigin,
  TestSchedule,
  TestScheduleInput,
  TestScheduleSummary,
  TestStatus,
  TestSummary,
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
import { applyFingerprintPatch, hasMatchableSignal } from "../fingerprint-patch";
import { summarizeFingerprint } from "../fingerprint-summary";
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
  /** Set/replace the test's free-form note; `null`/empty clears it. Omit to leave
   *  unchanged. Annotation only — never writes a new test_version. */
  notes?: string | null;
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
/** Whether a definition uses `{{baseUrl}}` (the only token left) — so it needs an environment
 *  to supply the base URL + cookies + localStorage before it can run. */
function usesBaseUrl(definition: TestDefinition): boolean {
  return /\{\{\s*baseUrl\s*\}\}/.test(JSON.stringify(definition));
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

/** Build a step from a manual `add step` input (test-detail). `navigate`/`screenshot` carry only
 *  plain data; `click`/`type` are authored by a raw selector, synthesized into a minimal locator
 *  whose `selectorOverride` the matcher tries first (no recorded fingerprint to fall back on).
 *  Trims and rejects empties here; the assembled definition is re-validated by the schema before
 *  it's stored. */
function buildNewStep(input: NewStepInput): Step {
  if (input.type === "navigate") {
    const url = (input.url ?? "").trim();
    if (!url) throw new BadRequestException("A navigation step needs a URL.");
    return { type: "navigate", url };
  }
  if (input.type === "screenshot") {
    const name = (input.name ?? "").trim();
    if (!name) throw new BadRequestException("A checkpoint needs a name.");
    return { type: "screenshot", name, captureMode: "fullpage", compareMode: "pixel" };
  }
  // click / type — a hand-authored locator: empty tag (unknown) + the raw selector as override.
  const selector = (input.selector ?? "").trim();
  if (!selector) throw new BadRequestException("This step needs a CSS or Playwright selector.");
  const target = { tag: "", selectorOverride: selector };
  if (input.type === "click") return { type: "click", target };
  return { type: "type", target, value: input.value ?? "" };
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

  /** Persist a (human) recording. `createdBy` is the uploader's email — the test's
   *  provenance (audit pair with createdAt). */
  async create(input: unknown, createdBy?: string): Promise<CreatedTest> {
    const definition = parseTestDefinition(input);
    const [created] = await this.db
      .insert(tests)
      .values({ name: definition.name, createdBy: createdBy ?? null })
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
        createdBy: tests.createdBy,
        promotedBy: tests.promotedBy,
        promotedAt: tests.promotedAt,
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
      return {
        id: r.id,
        name: r.name,
        createdAt: r.createdAt.toISOString(),
        status: r.status as TestStatus,
        origin: r.origin as TestOrigin,
        createdBy: r.createdBy,
        promotedBy: r.promotedBy,
        promotedAt: r.promotedAt ? r.promotedAt.toISOString() : null,
        // A recording needs an environment iff it uses {{baseUrl}}.
        needsEnvironment: usesBaseUrl(r.definition as TestDefinition),
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
        // The author is the AI; the human who promotes it is recorded as promotedBy.
        createdBy: "ai",
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
  async promote(id: string, body: PromoteDraftBody, promotedBy?: string): Promise<{ ok: true }> {
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
          .set({
            status: "active",
            folderId: body.folderId ?? null,
            promotedBy: promotedBy ?? null,
            promotedAt: new Date(),
          })
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
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null; // empty clears
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
    const [meta] = await this.db
      .select({ notes: tests.notes })
      .from(tests)
      .where(eq(tests.id, id))
      .limit(1);
    // A baseline image per checkpoint to draw masks on (default environment preferred, else any).
    const baselineRows = await this.db
      .select({
        name: baselines.checkpointName,
        environment: baselines.environment,
        key: baselines.artifactKey,
      })
      .from(baselines)
      .where(eq(baselines.testId, id));
    const baselineKeyByName = new Map<string, string>();
    for (const b of baselineRows) {
      if (!baselineKeyByName.has(b.name) || b.environment === "default") {
        baselineKeyByName.set(b.name, b.key);
      }
    }
    const baselineUrl = (name: string | null): string | null => {
      const key = name ? baselineKeyByName.get(name) : undefined;
      return key ? this.storage.getUrl(key) : null;
    };
    return {
      id: view.id,
      name: view.name,
      version: view.version,
      schedule,
      notes: meta?.notes ?? null,
      needsEnvironment: usesBaseUrl(def),
      defaults: (def.defaults?.waitBefore ?? []).map(toConfigWait),
      steps: def.steps.map((s, index): TestConfigStep => ({
        index,
        type: s.type,
        label: describeStep(s),
        supportsWaits: s.type !== "navigate",
        waitBefore: s.type === "navigate" ? [] : (s.waitBefore ?? []).map(toConfigWait),
        checkpointName: s.type === "screenshot" ? s.name : null,
        captureMode: s.type === "screenshot" ? (s.captureMode ?? "element") : null,
        compareMode: s.type === "screenshot" ? (s.compareMode ?? "pixel") : null,
        prompt: s.type === "screenshot" ? (s.prompt ?? null) : null,
        threshold: s.type === "screenshot" ? (s.threshold ?? null) : null,
        // Type-only: the literal value typed into the field (editable on Test Detail).
        value: s.type === "type" ? s.value : null,
        // The editable locator — present for steps with an element target (click, type,
        // element-mode screenshot); null for navigate and full-page / region screenshots.
        target: "target" in s ? summarizeFingerprint(s.target) : null,
        // Mask regions + a baseline to draw them on (screenshot steps only).
        masks: s.type === "screenshot" ? ((s.masks ?? []) as Rect[]) : [],
        baselineUrl: s.type === "screenshot" ? baselineUrl(s.name) : null,
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
   * Apply a config patch (waits + threshold + step locators) onto the test's latest
   * definition and write a NEW audited test_version (latest+1, `createdBy` = the editing
   * user). Locator edits merge onto the step's fingerprint, preserving its other signals.
   * Optimistic
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

    const editedSteps = def.steps.map((s, index) => {
      const p = stepPatch.get(index);
      // Removals are applied in the interleave below; navigate has no waits/threshold.
      if (!p || p.remove || s.type === "navigate") return s;
      let out = s;
      if (p.waitBefore !== undefined) {
        out = { ...out, waitBefore: mergeWaits(out.waitBefore, p.waitBefore) };
      }
      if (p.threshold !== undefined && out.type === "screenshot") {
        out = { ...out, threshold: p.threshold };
      }
      if (p.masks !== undefined && out.type === "screenshot") {
        out = { ...out, masks: p.masks };
      }
      if (p.compareMode !== undefined && out.type === "screenshot") {
        out = { ...out, compareMode: p.compareMode };
      }
      if (p.prompt !== undefined && out.type === "screenshot") {
        // A context checkpoint's prompt is optional — when blank it inherits the global default judge
        // prompt (resolved at run time). Normalise a blank prompt to OMIT the field: storing `""`
        // would violate the schema's `prompt: string().min(1)` and fail the save.
        const trimmed = p.prompt.trim();
        const next = { ...out };
        if (trimmed) next.prompt = trimmed;
        else delete next.prompt;
        out = next;
      }
      // Type-only: set the literal value typed into the field.
      if (p.value !== undefined && out.type === "type") {
        out = { ...out, value: p.value };
      }
      // Locator edit: merge the signal patch onto the step's fingerprint. Only steps
      // that have an element target (click / type / element-mode screenshot) carry one.
      if (p.target !== undefined && "target" in out && out.target) {
        const merged = applyFingerprintPatch(out.target, p.target);
        if (!hasMatchableSignal(merged)) {
          throw new BadRequestException(
            "This locator has no signal left to match on — keep at least a role, accessible name, visible text, or test id.",
          );
        }
        out = { ...out, target: merged };
      }
      return out;
    });

    // Manual inserts (test-detail "add step"). Anchored to ORIGINAL indices and built/validated
    // here; the entry navigation can never have a step inserted above it (replay starts there).
    const inserts = patch.inserts ?? [];
    const above = new Map<number, Step[]>();
    const below = new Map<number, Step[]>();
    for (const ins of inserts) {
      if (ins.position === "above" && ins.atIndex === 0) {
        throw new BadRequestException("A step can't be inserted above the entry navigation.");
      }
      const bucket = ins.position === "above" ? above : below;
      const arr = bucket.get(ins.atIndex) ?? [];
      arr.push(buildNewStep(ins.step));
      bucket.set(ins.atIndex, arr);
    }

    // Walk the original steps, interleaving inserts and dropping removals — so an insert keeps
    // its place relative to the step it was anchored to even as other steps are removed.
    const nextSteps: Step[] = [];
    editedSteps.forEach((s, index) => {
      for (const ins of above.get(index) ?? []) nextSteps.push(ins);
      if (!removed.has(index)) nextSteps.push(s);
      for (const ins of below.get(index) ?? []) nextSteps.push(ins);
    });

    // Checkpoint names are the baseline key, so they must be unique. Only enforced when steps are
    // added (a pre-existing definition is left untouched by waits/threshold/locator saves).
    if (inserts.length > 0) {
      const names = nextSteps
        .filter((s): s is Extract<Step, { type: "screenshot" }> => s.type === "screenshot")
        .map((s) => s.name);
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) {
        throw new BadRequestException(`Checkpoint name "${dup}" is already used — names must be unique.`);
      }
    }

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
