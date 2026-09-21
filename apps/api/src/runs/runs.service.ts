import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  baselines,
  currentDefinitionOf,
  environments,
  replayedDefinition,
  replayedTestId,
  runAssertions,
  runEvidence,
  runNetwork,
  runResults,
  runs,
  runSteps,
  tests,
} from "@varys/db";
import { diffPng } from "@varys/diff-engine";
import { type Boss, enqueueRun } from "@varys/queue";
import type {
  AssertionHistoryPoint,
  AssertionOutcome,
  AssertionResultView,
  CaptureMode,
  CompareMode,
  CheckpointView,
  FingerprintSummary,
  PersistResult,
  ReEvaluation,
  Rect,
  Resolution,
  ReviewState,
  RunEvidenceView,
  RunNetworkEvent,
  RunSummary,
  RunView,
  StepLabel,
  StepRun,
  TestKind,
  TuningInput,
} from "@varys/review-contract";
import {
  deriveAgentSessionState,
  deriveRunOutcome,
  deriveUnreachedRootCause,
  rollupRunStatus,
  type AgentSessionView,
  type RunFailureKind,
} from "@varys/review-contract";
import { describeStep, type TestDefinition } from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { summarizePinnedAssertion } from "../assertion-view";
import { summarizeFingerprint } from "../fingerprint-summary";
import { BOSS } from "../queue/queue.module";
import { SettingsService } from "../settings/settings.service";
import { STORAGE } from "../storage/storage.module";

const ENVIRONMENT = "default";

/**
 * The `baselines.viewport_key` a definition's viewport produces.
 *
 * Exported because an Agent Run Session has to look baselines up under exactly the key this
 * service's `approve` writes them under. Two spellings of the same rule is how a golden becomes
 * unfindable by the only path that wants it.
 */
export function viewportKeyOf(vp: TestDefinition["viewport"]): string {
  return `${vp.width}x${vp.height}@${vp.deviceScaleFactor}`;
}

/** The recorded target fingerprint per step, indexed by step position — what the
 *  locator looks for. Null for steps with no element target (navigate, full-page /
 *  region screenshot). The definition already holds this, so it's free to surface. */
function buildFingerprints(def: TestDefinition): (FingerprintSummary | null)[] {
  return def.steps.map((s) => ("target" in s ? summarizeFingerprint(s.target) : null));
}

/**
 * How many past verdicts an assertion's history strip carries. A cap rather than the whole
 * corpus: the strip is a "has this been failing all week?" glance, not the archive — and a test
 * running nightly for a year would otherwise put 365 points on every payload.
 */
const ASSERTION_HISTORY_LIMIT = 30;

export interface CreatedRun {
  runId: string;
}

// The per-checkpoint review read-model (CheckpointView / RunView) is the shared
// API↔UI contract — see @varys/review-contract.

@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BOSS) private readonly boss: Boss,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
    // Supplies the team-wide per-pixel default so in-viewer re-evaluation matches the runner.
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async create(
    testId: string,
    opts: {
      environmentId?: string;
      suiteRunId?: string;
      trace?: boolean;
      /** Who triggered this run (email / sentinel) and how it was triggered. */
      triggeredBy?: string;
      triggerSource?: "manual" | "suite" | "schedule" | "api";
    } = {},
  ): Promise<CreatedRun> {
    // An Agent-Driven Test is never executed by the worker: it has no steps, and its definition
    // is a zero-step placeholder that exists only so the shape is structurally valid. Replaying
    // it would produce a run that captured nothing and compared nothing — which `deriveRunOutcome`
    // has no checkpoints to redden, so it would read as a PASS. Refused here rather than at each
    // entry point, because this is the single door the ad-hoc route and the suite fan-out share.
    const [kindRow] = await this.db
      .select({ kind: tests.kind })
      .from(tests)
      .where(eq(tests.id, testId))
      .limit(1);
    if (kindRow?.kind === "agent") {
      throw new BadRequestException(
        "An Agent-Driven Test is run by your own local Claude, not by Varys — there are no steps for the worker to replay.",
      );
    }

    // What this run is about to replay comes off the test.
    const definition = await currentDefinitionOf(this.db, testId);
    if (!definition) throw new NotFoundException(`Test ${testId} not found`);

    const [run] = await this.db
      .insert(runs)
      .values({
        // The Run's own write-once copy of what it is about to replay, and its direct link to the
        // test (ADR 0008). The copy is what keeps this run legible after the test is edited.
        testId,
        definition,
        environmentId: opts.environmentId ?? null,
        suiteRunId: opts.suiteRunId ?? null,
        trace: opts.trace ?? false,
        triggeredBy: opts.triggeredBy ?? null,
        triggerSource: opts.triggerSource ?? null,
        status: "queued",
      })
      .returning({ id: runs.id });

    await enqueueRun(this.boss, run.id);
    return { runId: run.id };
  }

  /**
   * The run's assertion results (slice 09), each with its own history over time.
   *
   * The history is keyed on the assertion's stable, author-chosen `id` — which is precisely why
   * that id must never change: it is what joins tonight's verdict to the one from before someone
   * reworded the `check`. The rows carry the check text as it READ on each run, so the strip stays
   * honest about what was being asserted at the time.
   *
   * `pinned` comes from the definition the run REPLAYED, not the latest one: showing tonight's
   * comparison against a form that was edited this morning would misreport what actually ran.
   */
  private async assertionResults(
    runId: string,
    testId: string,
    definition: TestDefinition,
  ): Promise<AssertionResultView[]> {
    const rows = await this.db
      .select({
        assertionId: runAssertions.assertionId,
        checkText: runAssertions.checkText,
        outcome: runAssertions.outcome,
        mode: runAssertions.mode,
        cause: runAssertions.cause,
        leftValue: runAssertions.leftValue,
        rightValue: runAssertions.rightValue,
        detail: runAssertions.detail,
        reasoning: runAssertions.reasoning,
      })
      .from(runAssertions)
      .where(eq(runAssertions.runId, runId))
      .orderBy(runAssertions.assertionId);
    if (rows.length === 0) return [];

    // Every verdict this TEST has recorded for these assertions, oldest first — one query rather
    // than one per assertion.
    const past = await this.db
      .select({
        assertionId: runAssertions.assertionId,
        outcome: runAssertions.outcome,
        runId: runAssertions.runId,
        runTimestamp: runs.createdAt,
      })
      .from(runAssertions)
      .innerJoin(runs, eq(runs.id, runAssertions.runId))
      .where(
        and(
          eq(replayedTestId, testId),
          inArray(
            runAssertions.assertionId,
            rows.map((r) => r.assertionId),
          ),
        ),
      )
      .orderBy(runs.createdAt);
    const historyById = new Map<string, AssertionHistoryPoint[]>();
    for (const p of past) {
      const list = historyById.get(p.assertionId) ?? [];
      list.push({
        runId: p.runId,
        runTimestamp: p.runTimestamp.toISOString(),
        outcome: p.outcome as AssertionOutcome,
      });
      historyById.set(p.assertionId, list);
    }

    const declaredById = new Map((definition.assertions ?? []).map((a) => [a.id, a]));
    return rows.map((r): AssertionResultView => ({
      id: r.assertionId,
      check: r.checkText,
      outcome: r.outcome as AssertionOutcome,
      mode: r.mode === "judged" ? "judged" : "pinned",
      cause: (r.cause as AssertionResultView["cause"]) ?? null,
      left: r.leftValue,
      right: r.rightValue,
      detail: r.detail,
      reasoning: r.reasoning,
      pinned: summarizePinnedAssertion(declaredById.get(r.assertionId)?.pinned),
      // Newest kept when there are more than the cap, but still oldest-first for the strip.
      history: (historyById.get(r.assertionId) ?? []).slice(-ASSERTION_HISTORY_LIMIT),
    }));
  }

  async getById(runId: string): Promise<RunView> {
    const [row] = await this.db
      .select({
        status: runs.status,
        createdAt: runs.createdAt,
        environmentId: runs.environmentId,
        suiteRunId: runs.suiteRunId,
        error: runs.error,
        failedStepIndex: runs.failedStepIndex,
        trace: runs.trace,
        traceArtifactKey: runs.traceArtifactKey,
        triggeredBy: runs.triggeredBy,
        triggerSource: runs.triggerSource,
        notes: runs.notes,
        failureKind: runs.failureKind,
        agentSummary: runs.agentSummary,
        agentInstructions: runs.agentInstructions,
        agentLeaseSeconds: runs.agentLeaseSeconds,
        agentLeaseExpiresAt: runs.agentLeaseExpiresAt,
        testId: replayedTestId,
        testName: tests.name,
        kind: tests.kind,
        definition: replayedDefinition,
      })
      .from(runs)
      .innerJoin(tests, eq(tests.id, replayedTestId))
      .where(eq(runs.id, runId))
      .limit(1);
    if (!row) throw new NotFoundException(`Run ${runId} not found`);

    const kind: TestKind = row.kind === "agent" ? "agent" : "pinned";
    const isAgentRun = kind === "agent";

    // Capture mode lives on the screenshot step of the definition THIS RUN replayed; map it by
    // checkpoint name (absent ⇒ element, for definitions recorded before capture modes).
    const captureModes = new Map<string, CaptureMode>();
    // Compare mode likewise lives on the screenshot step of the definition that ran (absent ⇒
    // pixel, for definitions recorded before context compare).
    const compareModes = new Map<string, CompareMode>();
    for (const s of (row.definition as TestDefinition).steps) {
      if (s.type === "screenshot") {
        captureModes.set(s.name, s.captureMode ?? "element");
        compareModes.set(s.name, s.compareMode ?? "pixel");
      }
    }

    // Masks are the *current* ones a reviewer would edit — off the TEST's definition, which
    // after a persist holds the just-saved masks (the run's own copy may predate them).
    const masksByName = new Map<string, Rect[]>();
    const latestDef = await this.latestDefinition(row.testId);
    for (const s of latestDef.steps) {
      if (s.type === "screenshot") masksByName.set(s.name, (s.masks ?? []) as Rect[]);
    }

    // Environment name for the reviewer's context; "default" when none was chosen. `exists` is
    // what a re-run needs: an environment deleted since the run has to be re-chosen, not silently
    // dropped (which would run a {{baseUrl}} test with no base URL).
    const env = await this.runEnvironment(row.environmentId);
    const environment = env.name;

    const results = await this.db
      .select({
        name: runResults.checkpointName,
        reviewState: runResults.reviewState,
        resolution: runResults.resolution,
        resolvedBy: runResults.resolvedBy,
        resolvedAt: runResults.resolvedAt,
        diffScore: runResults.diffScore,
        judgeReasoning: runResults.judgeReasoning,
        threshold: runResults.threshold,
        healed: runResults.healed,
        actualArtifactKey: runResults.actualArtifactKey,
        baselineArtifactKey: runResults.baselineArtifactKey,
        diffArtifactKey: runResults.diffArtifactKey,
        captureTool: runResults.captureTool,
        captureViewport: runResults.captureViewport,
        captureDeviceScale: runResults.captureDeviceScale,
        createdAt: runResults.createdAt,
      })
      .from(runResults)
      .where(eq(runResults.runId, runId));

    // A run that was re-executed (e.g. redelivered by the queue before idempotent
    // writes landed) can carry more than one row per checkpoint. Collapse to the
    // latest pass per checkpoint name so the viewer never shows a checkpoint twice.
    // Belt-and-braces: the unique index on (run_id, checkpoint_name) now prevents
    // new dupes, but historical runs predate it.
    const latestResultByName = new Map<string, (typeof results)[number]>();
    for (const r of results) {
      const prev = latestResultByName.get(r.name);
      if (!prev || r.createdAt > prev.createdAt) latestResultByName.set(r.name, r);
    }
    const dedupedResults = [...latestResultByName.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    const url = (key: string | null) => (key ? this.storage.getUrl(key) : null);

    // Baseline audit trail per checkpoint: who approved the current golden for this
    // (test, checkpoint, env, viewport) and when. Surfaces the real approver (Slice 10).
    const vpKey = viewportKeyOf((row.definition as TestDefinition).viewport);
    const baselineRows = await this.db
      .select({
        checkpointName: baselines.checkpointName,
        approvedBy: baselines.approvedBy,
        approvedAt: baselines.approvedAt,
      })
      .from(baselines)
      .where(
        and(
          eq(baselines.testId, row.testId),
          eq(baselines.environment, environment),
          eq(baselines.viewportKey, vpKey),
        ),
      );
    const baselineByName = new Map(baselineRows.map((b) => [b.checkpointName, b]));

    // For a failed run there are no checkpoints — instead give the viewer the run's
    // step sequence (labels) so it can show which step failed and which never ran.
    const steps: StepLabel[] =
      row.status === "failed"
        ? (row.definition as TestDefinition).steps.map((s, index) => ({
            index,
            label: describeStep(s),
          }))
        : [];

    // The per-step execution timeline (every run): the steps that actually ran,
    // in order, with timing + outcome — the custom-timeline foundation.
    const stepRows = await this.db
      .select({
        index: runSteps.stepIndex,
        label: runSteps.label,
        checkpointName: runSteps.checkpointName,
        startedAt: runSteps.startedAt,
        durationMs: runSteps.durationMs,
        outcome: runSteps.outcome,
      })
      .from(runSteps)
      .where(eq(runSteps.runId, runId))
      .orderBy(runSteps.stepIndex);
    // Collapse duplicate passes: keep the latest row per step_index (the most recent
    // execution). Same defensiveness as the checkpoints above — the unique index on
    // (run_id, step_index) prevents new dupes; this fixes already-duplicated runs.
    const latestStepByIndex = new Map<number, (typeof stepRows)[number]>();
    for (const s of stepRows) {
      const prev = latestStepByIndex.get(s.index);
      if (!prev || s.startedAt > prev.startedAt) latestStepByIndex.set(s.index, s);
    }
    const timeline: StepRun[] = [...latestStepByIndex.values()]
      .sort((a, b) => a.index - b.index)
      .map((s) => ({
        index: s.index,
        label: s.label,
        checkpointName: s.checkpointName,
        startedAt: s.startedAt.toISOString(),
        durationMs: s.durationMs,
        outcome: s.outcome as "passed" | "failed",
      }));

    // The API traffic this run saw. Ordered by start so it reads as the run's own timeline, and
    // joined to the timeline above by `stepIndex` in the viewer. Written bounded by the worker,
    // so this needs no limit of its own.
    const networkRows = await this.db
      .select({
        stepIndex: runNetwork.stepIndex,
        method: runNetwork.method,
        url: runNetwork.url,
        resourceType: runNetwork.resourceType,
        status: runNetwork.status,
        failureText: runNetwork.failureText,
        durationMs: runNetwork.durationMs,
        ttfbMs: runNetwork.ttfbMs,
        startedAt: runNetwork.startedAt,
      })
      .from(runNetwork)
      .where(eq(runNetwork.runId, runId))
      .orderBy(runNetwork.startedAt);
    const network: RunNetworkEvent[] = networkRows.map((n) => ({
      stepIndex: n.stepIndex,
      method: n.method,
      url: n.url,
      resourceType: n.resourceType,
      status: n.status,
      failureText: n.failureText,
      durationMs: n.durationMs,
      ttfbMs: n.ttfbMs,
      startedAt: n.startedAt.toISOString(),
    }));

    // Assertion results + per-assertion history (slice 09).
    const assertions = await this.assertionResults(
      runId,
      row.testId,
      row.definition as TestDefinition,
    );

    // Extra screenshots an agent attached during the session. Read for every run rather than
    // gated on the kind: the table is empty for a pinned one, and a gate here would be a second
    // place the two kinds have to agree about what an agent run is.
    const evidenceRows = await this.db
      .select({
        id: runEvidence.id,
        artifactKey: runEvidence.artifactKey,
        note: runEvidence.note,
        createdAt: runEvidence.createdAt,
      })
      .from(runEvidence)
      .where(eq(runEvidence.runId, runId))
      .orderBy(runEvidence.createdAt);
    const evidence: RunEvidenceView[] = evidenceRows.map((e) => ({
      id: e.id,
      url: this.storage.getUrl(e.artifactKey),
      note: e.note,
      createdAt: e.createdAt.toISOString(),
    }));

    const checkpoints: CheckpointView[] = dedupedResults.map(
      (r): CheckpointView => ({
        name: r.name,
        reviewState: r.reviewState as ReviewState,
        captureMode: captureModes.get(r.name) ?? "element",
        // An Agent-Driven Test's checkpoints are ALWAYS compared contextually — never pixel
        // diffed, in any configuration (PRD, Out of Scope 9). The map above is built from the
        // replayed definition's screenshot steps and this kind has none, so falling through to `pixel`
        // default would dress a judged verdict up as a diff score, offer mask and threshold
        // editors for a comparison that has neither, and read "Within threshold" off a `threshold`
        // column that only exists because it is NOT NULL. Stated from the kind rather than
        // inferred from the definition, because there is no definition to infer it from.
        compareMode: isAgentRun ? "context" : (compareModes.get(r.name) ?? "pixel"),
        resolution: r.resolution as Resolution | null,
        resolvedBy: r.resolvedBy,
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        diffScore: r.diffScore,
        judgeReasoning: r.judgeReasoning,
        threshold: r.threshold,
        healed: r.healed,
        masks: masksByName.get(r.name) ?? [],
        actualUrl: url(r.actualArtifactKey),
        baselineUrl: url(r.baselineArtifactKey),
        diffUrl: url(r.diffArtifactKey),
        baselineApprovedBy: baselineByName.get(r.name)?.approvedBy ?? null,
        baselineApprovedAt: baselineByName.get(r.name)?.approvedAt?.toISOString() ?? null,
        // Null rather than a row of nulls when the session volunteered nothing, so the view has
        // one thing to test instead of three.
        capture:
          r.captureTool == null && r.captureViewport == null && r.captureDeviceScale == null
            ? null
            : {
                tool: r.captureTool,
                viewport: r.captureViewport,
                deviceScale: r.captureDeviceScale,
              },
      }),
    );

    // Derived before the outcome, because the outcome depends on it: a session still inside its
    // lease is not a run that has finished failing, however many slots are still empty.
    const session = this.agentSessionOf(row);

    return {
      runId,
      status: row.status,
      // Derived display refinement — baseline-creation vs verification (see deriveRunOutcome).
      outcome: deriveRunOutcome(checkpoints, {
        status: row.status,
        error: row.error,
        agentSession: session?.state ?? null,
      }),
      testId: row.testId,
      suiteRunId: row.suiteRunId,
      testName: row.testName,
      environment,
      environmentId: env.exists ? row.environmentId : null,
      environmentMissing: !!row.environmentId && !env.exists,
      trace: row.trace,
      runTimestamp: row.createdAt.toISOString(),
      triggeredBy: row.triggeredBy,
      triggerSource: row.triggerSource,
      error: row.error,
      steps,
      failedStepIndex: row.failedStepIndex ?? null,
      fingerprints: buildFingerprints(row.definition as TestDefinition),
      traceUrl: url(row.traceArtifactKey),
      timeline,
      network,
      notes: row.notes ?? null,
      // Which class of failure this was (Slice 19), recorded by the runner rather than inferred.
      // The run-detail repair affordance keys on exactly `locator`, so widening the vocabulary
      // (slice 08) cannot accidentally offer a repair for a crash. An unrecognised stored value
      // degrades to null rather than through to the client.
      failureKind: isRunFailureKind(row.failureKind) ? row.failureKind : null,
      checkpoints,
      // Each assertion separately, with its own history — never folded into the checkpoints, and
      // never collapsed to a single pass/fail: `extraction-failed` and `relation-false` say
      // different things about who is wrong.
      assertions,
      kind,
      // Both null for a pinned run — it has no agent, and there is nothing to say so about.
      agentSummary: row.agentSummary ?? null,
      agentInstructions: row.agentInstructions ?? null,
      evidence,
      // Read off `checkpoints`, which is ordered by `created_at` — stamped in Manifest order when
      // the rows were seeded, so this is the journey's own sequence and not an arbitrary one.
      // Computed here rather than in the client for the same reason `outcome` is: a summary of a
      // failure that two surfaces could word differently is a summary nobody can quote.
      unreached: deriveUnreachedRootCause(checkpoints),
      // The Agent Run Session's bound and where it stands against it. Evaluated against the clock
      // AT READ TIME, and nothing writes the answer down — an expired session needs no sweeper to
      // be over, because the run has been `failed`/`unreached` since its rows were seeded. What
      // this adds is the ability to SAY so: before the lease, a run with unfilled slots and no
      // summary could equally have been an agent still walking it, and the view had to word itself
      // around not knowing.
      session,
    };
  }

  /**
   * The **Agent Run Session** behind a run row, or null for a pinned run (and for an agent run
   * started before leases existed).
   *
   * Evaluated against the clock AT READ TIME — nothing writes the answer down, because an expired
   * session needs no sweeper to be over: the run has been `failed`/`unreached` since its rows were
   * seeded, and this only adds the ability to SAY which.
   *
   * Shared by the detail view and the list on purpose. That state decides whether a run is allowed
   * to read `running`, so two surfaces deriving it separately would eventually disagree about the
   * same run on the same screen.
   */
  private agentSessionOf(row: {
    agentLeaseSeconds: number | null;
    agentLeaseExpiresAt: Date | null;
    agentSummary: string | null;
  }): AgentSessionView | null {
    if (!row.agentLeaseExpiresAt || row.agentLeaseSeconds == null) return null;
    return {
      leaseSeconds: row.agentLeaseSeconds,
      leaseExpiresAt: row.agentLeaseExpiresAt.toISOString(),
      state: deriveAgentSessionState(
        { summaryWritten: row.agentSummary != null, leaseExpiresAt: row.agentLeaseExpiresAt },
        Date.now(),
      ),
    };
  }

  /** The test's current definition (the source of "current" masks/threshold). */
  private async latestDefinition(testId: string): Promise<TestDefinition> {
    const definition = await currentDefinitionOf(this.db, testId);
    if (!definition) throw new NotFoundException(`Test ${testId} has no definition`);
    return definition as TestDefinition;
  }

  /**
   * The run's environment NAME — the key baselines are stored and looked up under.
   * "default" when the run had no environment, or its environment was deleted (a
   * dangling id degrades gracefully). Mirrors the runner's own resolution so approve
   * seeds/replaces under the very environment the run executed against.
   */
  private async environmentName(environmentId: string | null): Promise<string> {
    return (await this.runEnvironment(environmentId)).name;
  }

  /** Same resolution, keeping the "does it still exist?" answer — which is what a re-run needs
   *  and what `environmentName` throws away (a dangling id reads as "default" there, and offering
   *  a one-click re-run against "default" would drop the base URL a `{{baseUrl}}` test needs). */
  private async runEnvironment(
    environmentId: string | null,
  ): Promise<{ name: string; exists: boolean }> {
    if (!environmentId) return { name: ENVIRONMENT, exists: false };
    const [env] = await this.db
      .select({ name: environments.name })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .limit(1);
    return { name: env?.name ?? ENVIRONMENT, exists: !!env };
  }

  /** Every STANDALONE run, newest first — the Runs history (all outcomes).
   *  Suite-run children are excluded: they surface through their parent's
   *  aggregate row + report, so one fan-out doesn't flood the flat list.
   *  Pass `testId` to scope to one test's run history (the TestDetail panel). */
  async listRuns(limit = 100, testId?: string): Promise<RunSummary[]> {
    const rows = await this.db
      .select({
        runId: runs.id,
        status: runs.status,
        environmentId: runs.environmentId,
        error: runs.error,
        createdAt: runs.createdAt,
        triggeredBy: runs.triggeredBy,
        triggerSource: runs.triggerSource,
        // The Agent Run Session's bound. Read by the LIST as well as the detail view, because a
        // session walking the journey right now and one that ended red an hour ago are otherwise
        // the same row of `missing` slots, and the list has no other signal to tell them apart.
        agentLeaseSeconds: runs.agentLeaseSeconds,
        agentLeaseExpiresAt: runs.agentLeaseExpiresAt,
        agentSummary: runs.agentSummary,
        testId: replayedTestId,
        testName: tests.name,
      })
      .from(runs)
      .innerJoin(tests, eq(tests.id, replayedTestId))
      .where(
        testId ? and(isNull(runs.suiteRunId), eq(replayedTestId, testId)) : isNull(runs.suiteRunId),
      )
      .orderBy(desc(runs.createdAt))
      .limit(limit);

    // Resolve environment names in one batch ("default" when a run has no env).
    const envIds = [
      ...new Set(rows.map((r) => r.environmentId).filter((x): x is string => x != null)),
    ];
    const envNames = new Map<string, string>();
    if (envIds.length) {
      const envs = await this.db
        .select({ id: environments.id, name: environments.name })
        .from(environments)
        .where(inArray(environments.id, envIds));
      for (const e of envs) envNames.set(e.id, e.name);
    }

    // One batched read of every listed run's checkpoint verdicts, grouped per run, so the
    // display outcome (baseline vs verified, …) is derived once via the shared helper.
    const runIds = rows.map((r) => r.runId);
    const checkpointsByRun = new Map<string, { reviewState: ReviewState; resolution: Resolution | null }[]>();
    if (runIds.length) {
      const resultRows = await this.db
        .select({
          runId: runResults.runId,
          reviewState: runResults.reviewState,
          resolution: runResults.resolution,
        })
        .from(runResults)
        .where(inArray(runResults.runId, runIds));
      for (const rr of resultRows) {
        const list = checkpointsByRun.get(rr.runId) ?? [];
        list.push({ reviewState: rr.reviewState as ReviewState, resolution: rr.resolution as Resolution | null });
        checkpointsByRun.set(rr.runId, list);
      }
    }

    return rows.map((r): RunSummary => {
      const session = this.agentSessionOf(r);
      return {
        runId: r.runId,
        testId: r.testId,
        testName: r.testName,
        environment: r.environmentId ? (envNames.get(r.environmentId) ?? ENVIRONMENT) : ENVIRONMENT,
        status: r.status,
        outcome: deriveRunOutcome(checkpointsByRun.get(r.runId) ?? [], {
          status: r.status,
          error: r.error,
          agentSession: session?.state ?? null,
        }),
        runTimestamp: r.createdAt.toISOString(),
        error: r.error,
        triggeredBy: r.triggeredBy,
        triggerSource: r.triggerSource,
        session,
      };
    });
  }

  /** Set (or clear) a run's free-form note. Empty/whitespace clears it (→ null). 404 if
   *  the run doesn't exist. Annotation only — touches nothing else about the run. */
  async setNotes(runId: string, notes: string | null): Promise<{ ok: true }> {
    const trimmed = (notes ?? "").trim();
    const updated = await this.db
      .update(runs)
      .set({ notes: trimmed || null, updatedAt: new Date() })
      .where(eq(runs.id, runId))
      .returning({ id: runs.id });
    if (updated.length === 0) throw new NotFoundException(`Run ${runId} not found`);
    return { ok: true };
  }

  /**
   * Delete a single run and its output — `run_results` + `run_steps`, then the run row.
   * Irreversible, no rollback. Orphaned artifact blobs (the run's trace and each
   * checkpoint's actual + diff screenshots) are purged best-effort afterwards; a blob the
   * `baselines` table still points at (an `actual` that was approved into the live golden)
   * is KEPT, as is the shared baseline key. `test_schedules.lastRunId` clears itself via
   * its ON DELETE SET NULL FK.
   */
  async deleteRun(runId: string): Promise<{ ok: true }> {
    const [run] = await this.db
      .select({ id: runs.id, trace: runs.traceArtifactKey })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) throw new NotFoundException(`Run ${runId} not found`);

    // If it's still in flight, cancel it FIRST so the worker stops replaying before we remove the
    // rows (the runner re-checks status between steps and unwinds on `cancelled`/row-gone).
    await this.db
      .update(runs)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])));

    // Blobs this run owns: its trace + each result's actual/diff. NOT the baseline key —
    // that blob belongs to the `baselines` table (the golden), shared across runs.
    const results = await this.db
      .select({ actual: runResults.actualArtifactKey, diff: runResults.diffArtifactKey })
      .from(runResults)
      .where(eq(runResults.runId, runId));
    const keys = new Set<string>();
    if (run.trace) keys.add(run.trace);
    for (const r of results) for (const k of [r.actual, r.diff]) if (k) keys.add(k);
    // Agent-attached evidence belongs to this run and nothing else — it keys no baseline by
    // construction, so it is always the run's to purge.
    const evidence = await this.db
      .select({ key: runEvidence.artifactKey })
      .from(runEvidence)
      .where(eq(runEvidence.runId, runId));
    for (const e of evidence) if (e.key) keys.add(e.key);

    // An approved checkpoint's `actual` becomes the live golden (approve reuses the key),
    // so never purge a blob the baselines table still references.
    if (keys.size) {
      const live = await this.db
        .select({ key: baselines.artifactKey })
        .from(baselines)
        .where(inArray(baselines.artifactKey, [...keys]));
      for (const b of live) keys.delete(b.key);
    }

    // Non-cascading FK chain: results + assertions + steps + network before the run row, in one
    // transaction.
    await this.db.transaction(async (tx) => {
      await tx.delete(runResults).where(eq(runResults.runId, runId));
      await tx.delete(runEvidence).where(eq(runEvidence.runId, runId));
      await tx.delete(runAssertions).where(eq(runAssertions.runId, runId));
      await tx.delete(runSteps).where(eq(runSteps.runId, runId));
      await tx.delete(runNetwork).where(eq(runNetwork.runId, runId));
      await tx.delete(runs).where(eq(runs.id, runId));
    });

    // The DB delete is the source of truth — an orphaned blob is harmless, so purge after.
    for (const key of keys) {
      await this.storage.delete(key).catch(() => undefined);
    }
    return { ok: true };
  }

  /**
   * Re-derive a run's review status from its checkpoints after a decision
   * (approve / reject) or a mask-threshold re-judge. The worker stamps `runs.status`
   * once at replay time, so without this the Runs table (and dashboard / detail header,
   * which all read the stored column) keep showing "needs review" after the last
   * checkpoint is resolved.
   *
   * Only post-review statuses roll up. Execution-failed runs are left as-is —
   * reviewing the partial checkpoints a run captured before it failed must not flip it
   * to passed — and queued/running are owned by the worker. Per-checkpoint effective
   * status mirrors the UI: approved→passed, rejected→regression, else the stored
   * reviewState. The rollup itself is {@link rollupRunStatus} — shared with the agent-run path,
   * which reaches the same column from the other direction (filling a Checkpoint Manifest slot
   * rather than resolving a finished run), and must not be allowed to disagree with this one.
   */
  private async recomputeRunStatus(runId: string): Promise<void> {
    const [run] = await this.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run || (run.status !== "passed" && run.status !== "needs_review")) return;

    const results = await this.db
      .select({ reviewState: runResults.reviewState, resolution: runResults.resolution })
      .from(runResults)
      .where(eq(runResults.runId, runId));

    const next = rollupRunStatus(
      results.map((r) => ({
        reviewState: r.reviewState as ReviewState,
        resolution: r.resolution as Resolution | null,
      })),
    );
    if (next === run.status) return;
    await this.db.update(runs).set({ status: next, updatedAt: new Date() }).where(eq(runs.id, runId));
  }

  /** Approve a checkpoint: promote a pending seed (or replace an active baseline) and audit it.
   *  `approvedBy` is the signed-in user (the irreversible action's audit trail, DESIGN §4). */
  async approve(runId: string, checkpointName: string, approvedBy: string): Promise<{ ok: true }> {
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
      .select({
        testId: replayedTestId,
        definition: replayedDefinition,
        environmentId: runs.environmentId,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!ctx) throw new NotFoundException(`Run ${runId} not found`);
    const vpKey = viewportKeyOf((ctx.definition as TestDefinition).viewport);
    // Seed/replace under the run's OWN environment, not a hardcoded "default" — else
    // the next run against that environment never finds the baseline. (Slice 2 fix.)
    // reEvaluate/persistMasks touch no baselines, so they're unaffected by env.
    const environment = await this.environmentName(ctx.environmentId);

    if (result.reviewState === "pending-baseline") {
      if (!result.actualArtifactKey) {
        throw new BadRequestException("no actual artifact to promote");
      }
      await this.db.insert(baselines).values({
        testId: ctx.testId,
        checkpointName,
        environment,
        viewportKey: vpKey,
        artifactKey: result.actualArtifactKey,
        approvedBy,
        approvedAt: new Date(),
      });
    } else if (result.reviewState === "diff" || result.reviewState === "passed") {
      // `diff` = an over-threshold change accepted as the new golden.
      // `passed` = re-baseline a *passing* capture (Slice 17.4): re-anchor the golden to
      // this run's actual even though it matched (e.g. to lock in accepted drift). Both
      // replace the existing golden identically — a passing checkpoint always has one.
      const [existing] = await this.db
        .select({ id: baselines.id, artifactKey: baselines.artifactKey })
        .from(baselines)
        .where(
          and(
            eq(baselines.testId, ctx.testId),
            eq(baselines.checkpointName, checkpointName),
            eq(baselines.environment, environment),
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
          approvedBy,
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
      .set({ resolution: "approved", resolvedBy: approvedBy, resolvedAt: new Date() })
      .where(eq(runResults.id, result.id));
    await this.recomputeRunStatus(runId);
    return { ok: true };
  }

  /**
   * Bulk-approve every checkpoint in a run that still needs review
   * (`pending-baseline` | `diff`, undecided), in one audited operation. Each is
   * approved via the single-checkpoint path, so it seeds/replaces and audits its
   * baseline identically. Passing and already-decided checkpoints are left
   * untouched. Bulk reject is intentionally out of scope.
   */
  async approveAll(runId: string, approvedBy: string): Promise<{ approved: number }> {
    const candidates = await this.db
      .select({ name: runResults.checkpointName })
      .from(runResults)
      .where(
        and(
          eq(runResults.runId, runId),
          inArray(runResults.reviewState, ["pending-baseline", "diff"]),
          isNull(runResults.resolution),
        ),
      );
    for (const c of candidates) {
      await this.approve(runId, c.name, approvedBy);
    }
    return { approved: candidates.length };
  }

  /** Reject a checkpoint: record a regression; the baseline is left untouched.
   *  `resolvedBy` is the signed-in user (audit pair with the recorded decision). */
  async reject(runId: string, checkpointName: string, resolvedBy: string): Promise<{ ok: true }> {
    const [result] = await this.db
      .select({ id: runResults.id, reviewState: runResults.reviewState, resolution: runResults.resolution })
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
    // A passing checkpoint matched its baseline — there's nothing to reject (you'd
    // re-baseline it via approve instead).
    if (result.reviewState === "passed") {
      throw new BadRequestException("can't reject a passing checkpoint");
    }
    // An unfilled Checkpoint Manifest slot captured nothing, so there is no regression to
    // confirm. Refused rather than tolerated: a resolution on such a row is meaningless to
    // `deriveRunOutcome` (which reads `missing` before `resolution`) but WOULD change how the
    // row renders, so allowing it lets the badge disagree with the run's outcome.
    if (result.reviewState === "missing") {
      throw new BadRequestException("can't reject a checkpoint the run never captured");
    }
    await this.db
      .update(runResults)
      .set({ resolution: "rejected", resolvedBy, resolvedAt: new Date() })
      .where(eq(runResults.id, result.id));
    await this.recomputeRunStatus(runId);
    return { ok: true };
  }

  /**
   * Re-evaluate (preview): re-diff a checkpoint's STORED baseline+actual with
   * candidate masks/threshold — no browser, no new capture, no mutation. Returns
   * the new verdict/score and a transient diff image (data URL) for live display.
   */
  async reEvaluate(
    runId: string,
    checkpointName: string,
    input: TuningInput,
  ): Promise<ReEvaluation> {
    const [r] = await this.db
      .select({
        baselineArtifactKey: runResults.baselineArtifactKey,
        actualArtifactKey: runResults.actualArtifactKey,
        threshold: runResults.threshold,
        testKind: tests.kind,
      })
      .from(runResults)
      .innerJoin(runs, eq(runs.id, runResults.runId))
      .innerJoin(tests, eq(tests.id, replayedTestId))
      .where(and(eq(runResults.runId, runId), eq(runResults.checkpointName, checkpointName)))
      .limit(1);
    if (!r) {
      throw new NotFoundException(`Checkpoint ${checkpointName} not found for run ${runId}`);
    }
    // The last pixel door standing open for this kind. The other one mutates; this one does not —
    // which is exactly why it was the easy one to overlook, and exactly why it matters: it hands
    // back a diff score and a diff image for a checkpoint that was judged rather than measured,
    // and a reviewer shown "0.4% different" reads it as the verdict. The guarantee is that NO
    // pixel path is reachable for this kind, not that none of them writes.
    this.assertPixelComparable(
      r.testKind,
      "there is no pixel score to re-evaluate, and no mask or threshold that would change the verdict",
    );
    const { baseline, actual } = await this.loadDiffInputs(
      r.baselineArtifactKey,
      r.actualArtifactKey,
    );
    const threshold = input.threshold ?? r.threshold;
    const { perPixel } = await this.settings.getImageComparison();
    const { verdict, score, diffImage } = diffPng(
      baseline,
      actual,
      threshold,
      input.masks ?? [],
      perPixel,
    );
    return {
      verdict,
      diffScore: score,
      threshold,
      diffImage: `data:image/png;base64,${diffImage.toString("base64")}`,
    };
  }

  /**
   * Persist masks/threshold: write the named screenshot step's masks/threshold onto the
   * test's definition (audited), then re-judge ONLY this checkpoint's run_result against the
   * stored artifacts. A now-within-threshold checkpoint flips to `passed` and no longer awaits
   * a decision. Future runs replay the edited definition; no other historical run is touched —
   * each carries its own copy of what it ran.
   */
  async persistMasks(
    runId: string,
    checkpointName: string,
    input: TuningInput,
    createdBy: string,
  ): Promise<PersistResult> {
    const [ctx] = await this.db
      .select({
        testId: replayedTestId,
        testKind: tests.kind,
        runResultId: runResults.id,
        baselineArtifactKey: runResults.baselineArtifactKey,
        actualArtifactKey: runResults.actualArtifactKey,
        threshold: runResults.threshold,
      })
      .from(runResults)
      .innerJoin(runs, eq(runs.id, runResults.runId))
      .innerJoin(tests, eq(tests.id, replayedTestId))
      .where(and(eq(runResults.runId, runId), eq(runResults.checkpointName, checkpointName)))
      .limit(1);
    if (!ctx) {
      throw new NotFoundException(`Checkpoint ${checkpointName} not found for run ${runId}`);
    }
    // An Agent-Driven Test's definition is the zero-step placeholder written at creation and
    // never edited: there are no masks and no pixel threshold to tune. Guarded here rather than
    // left to a reachability argument, because agent-driven runs now exist and the argument was
    // only ever "nothing can reach a checkpoint of one yet".
    this.assertPixelComparable(
      ctx.testKind,
      "there are no masks or thresholds to save — edit its comparison prompt on the test instead",
    );

    // 1. The masks/threshold onto the test's definition, at this step.
    const def = (await currentDefinitionOf(this.db, ctx.testId)) as TestDefinition | null;
    if (!def) throw new NotFoundException(`Test ${ctx.testId} has no definition`);
    const masks = (input.masks ?? []) as Rect[];
    const nextDefinition: TestDefinition = {
      ...def,
      steps: def.steps.map((s) =>
        s.type === "screenshot" && s.name === checkpointName
          ? { ...s, masks, ...(input.threshold != null ? { threshold: input.threshold } : {}) }
          : s,
      ),
    };
    // The in-viewer mask/threshold persist is a definition write like any other: it lands on the
    // test, in place, and records who did it.
    await this.db
      .update(tests)
      .set({ definition: nextDefinition, updatedBy: createdBy, updatedAt: new Date() })
      .where(eq(tests.id, ctx.testId));

    const threshold = input.threshold ?? ctx.threshold;

    // 2. Re-judge ONLY when there's a baseline to diff against. A pending-baseline checkpoint
    //    has nothing to compare yet — the saved masks live on the test's definition and apply
    //    once its first capture is approved as baseline and on future runs (the review reads
    //    masks from that definition, so they show up immediately).
    if (!ctx.baselineArtifactKey || !ctx.actualArtifactKey) {
      return { reviewState: "pending-baseline", diffScore: 0, threshold };
    }
    const { baseline, actual } = await this.loadDiffInputs(
      ctx.baselineArtifactKey,
      ctx.actualArtifactKey,
    );
    const { perPixel } = await this.settings.getImageComparison();
    const { verdict, score, diffImage } = diffPng(baseline, actual, threshold, masks, perPixel);
    if (verdict === "match") {
      await this.db
        .update(runResults)
        .set({ reviewState: "passed", diffScore: score, threshold, diffArtifactKey: null })
        .where(eq(runResults.id, ctx.runResultId));
    } else {
      const diffKey = `runs/${runId}/${checkpointName}.diff.png`;
      await this.storage.put(diffKey, diffImage);
      await this.db
        .update(runResults)
        .set({ reviewState: "diff", diffScore: score, threshold, diffArtifactKey: diffKey })
        .where(eq(runResults.id, ctx.runResultId));
    }
    // Tuning a diff back within threshold resolves the last pending checkpoint — keep
    // the run's stored status in step with that, same as approve/reject.
    await this.recomputeRunStatus(runId);
    return {
      reviewState: verdict === "match" ? "passed" : "diff",
      diffScore: score,
      threshold,
    };
  }

  /**
   * Refuse a pixel operation on an Agent-Driven Test's checkpoint.
   *
   * Two doors reach the pixel engine from a run review — the preview re-diff and the committing
   * mask save — and both have to be locked, because the guarantee this kind makes is about
   * REACHABILITY, not about which of them happens to write. The lock is spelled once so the two
   * cannot drift into disagreeing about whether this kind has a threshold; `consequence` is the
   * only part that differs, because "there is nothing to re-evaluate" and "there is nothing to
   * save" are different sentences to the person who just clicked.
   */
  private assertPixelComparable(testKind: string | null, consequence: string): void {
    if (testKind !== "agent") return;
    throw new BadRequestException(
      `This checkpoint belongs to an Agent-Driven Test. Its capture was compared contextually — by the session that took it, holding both images — so ${consequence}. The agent's reasoning on the run is the record of how it was judged.`,
    );
  }

  /** Load a checkpoint's stored baseline+actual bytes for an in-place re-diff. */
  private async loadDiffInputs(
    baselineKey: string | null,
    actualKey: string | null,
  ): Promise<{ baseline: Buffer; actual: Buffer }> {
    if (!baselineKey || !actualKey) {
      throw new BadRequestException("checkpoint has no baseline to re-evaluate against");
    }
    const baseline = await this.storage.get(baselineKey);
    const actual = await this.storage.get(actualKey);
    if (!baseline || !actual) throw new BadRequestException("stored artifacts are missing");
    return { baseline, actual };
  }
}

/** Whether a stored `failure_kind` is one this build knows. An unrecognised value (written by a
 *  newer deployment, or by hand) degrades to null rather than reaching the client as a class no
 *  surface can render. */
function isRunFailureKind(value: string | null): value is Exclude<RunFailureKind, null> {
  return (
    value === "locator" ||
    value === "pixel" ||
    value === "judge" ||
    value === "assertion" ||
    value === "timeout" ||
    value === "crash" ||
    value === "unreached"
  );
}
