import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  agentCheckpoints,
  baselines,
  environments,
  runEvidence,
  runResults,
  runs,
  testVersions,
  tests,
} from "../db/schema";
import {
  deriveAgentSessionState,
  deriveRunOutcome,
  describeLease,
  rollupRunStatus,
  type Resolution,
  type ReviewState,
  type RunFailureKind,
  type RunOutcome,
} from "@varys/review-contract";
import type { TestDefinition } from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { viewportKeyOf } from "../runs/runs.service";
import { SettingsService } from "../settings/settings.service";
import { AgentInstructionsService } from "../tests/agent-instructions.service";
import { STORAGE } from "../storage/storage.module";
import { decodePng, type CallerContext, type ImageArg } from "./png";

/** The environment name a run with no environment is keyed under — the same fallback
 *  `RunsService` uses, so an env-less agent run and an env-less replay find the same baselines. */
const NO_ENVIRONMENT = "default";

/** One slot of the Checkpoint Manifest as the agent receives it. */
export interface AgentRunManifestSlot {
  /** Position in the journey, 1-based for the model (the DB is 0-based). */
  step: number;
  /** The ONLY name this slot may ever be reported under. */
  name: string;
  /** How to reach this state, carrying on from the previous slot. */
  instructions: string;
  /** What must be true in the capture for it to match its baseline. Falls back to the configured
   *  global default judge prompt when the checkpoint leaves it blank. */
  comparePrompt: string;
  /** Whether an APPROVED baseline exists for this slot in this environment. False means there is
   *  nothing to compare against yet and the capture goes to a human for approval — so a verdict
   *  on it would be a guess about a picture nobody has blessed. */
  hasBaseline: boolean;
}

/** The agent's judgement of one slot. Only ever its own comparison of two pictures it holds —
 *  Varys makes no model call on this path and has no second opinion to offer. */
export type AgentVerdict = "pass" | "fail";

/**
 * How a capture was produced, as the agent describes it. Every field optional and none verified:
 * Varys hosts no browser for this kind, so this is testimony, recorded because a reviewer
 * comparing two baffling images needs to know whether they were even taken the same way.
 */
export interface AgentCaptureMeta {
  /** e.g. `chrome-devtools`, `playwright`, `computer-use`. */
  tool?: string;
  /** e.g. `1440x900`. Free text — an unconstrained capture has no canonical spelling. */
  viewport?: string;
  /** Device pixel ratio, e.g. `2` on a Retina display. */
  deviceScale?: number;
}

/** What filling one Manifest slot reports back — including the state Varys actually recorded,
 *  which is not always the one the verdict asked for. */
export interface AgentSubmitResult {
  runId: string;
  checkpoint: string;
  verdict: AgentVerdict;
  /** Was there an approved baseline to judge against? When false, the verdict is inert. */
  hadBaseline: boolean;
  /** What Varys STORED — `pending-baseline` whenever there was no baseline, whatever was said. */
  reviewState: ReviewState;
  /** Manifest slots still unfilled. While this is non-empty the run is red. */
  remaining: string[];
  note: string;
}

/** What closing the session reports back, in the same vocabulary the run view will show. */
export interface AgentFinishResult {
  runId: string;
  /** The derived outcome — the word to report this run in, and often not `passed`. */
  outcome: RunOutcome;
  status: string;
  failureKind: RunFailureKind | null;
  checkpoints: { name: string; reviewState: ReviewState }[];
  /** Slots that were never filled — the run's root finding when it is non-empty. */
  unreached: string[];
  path: string;
  note: string;
}

/** What starting an Agent Run Session hands back: everything the run needs, in one call. */
export interface AgentRunSession {
  runId: string;
  testId: string;
  testName: string;
  environment: string;
  environmentId: string | null;
  /** The environment's base URL, when it has one — where the journey starts. */
  baseUrl: string | null;
  /** The fully composed AI Instructions, exactly as stored on the run. */
  instructions: string;
  /** The closed set of slots this run must fill, in journey order. */
  manifest: AgentRunManifestSlot[];
  /** Slot names, in the order their baseline images follow this text block. Empty when no slot
   *  has an approved baseline yet. */
  baselineImages: string[];
  /**
   * The wall-clock lease this session is bounded by, in seconds, and the instant it runs out
   * (ISO). Server-side and not negotiable: past the deadline Varys closes the session and refuses
   * every further submission, whatever the instructions say. It exists because retrying is the
   * agent's own business — and an agent retrying a state that will never appear has no reason
   * ever to stop, on someone else's subscription quota.
   */
  leaseSeconds: number;
  leaseExpiresAt: string;
  /** Where a human opens this run in Varys, relative to the app's origin. */
  path: string;
  /** What this run's state MEANS right now, in the terms it has to be reported in. */
  note: string;
  /** Stripped by the MCP controller into image content blocks — never part of the JSON payload. */
  images?: { name: string; data: string }[];
}

/**
 * Starting an **Agent Run Session** — the moment a run begins, and the reason its honesty does
 * not depend on the agent.
 *
 * Varys supplies no browser, no perception layer and no action tools here. How Claude reaches
 * each state is its own business (Chrome DevTools, Playwright, computer use — whatever works on
 * the app in front of it) and Varys never observes the driving. What Varys does instead is
 * decide, before the agent acts at all, what a green would have to consist of:
 *
 *  - the run is created **`failed` / `unreached`**, and
 *  - one `run_results` row per Manifest slot is pre-seeded **`missing`**.
 *
 * Both happen in one transaction, before the tool returns. That is what makes the guarantee
 * survive an agent that crashes, disconnects, closes its laptop lid, or simply decides to check
 * less — none of which involve it cooperating with a reconciliation step it might never reach.
 * Call the tool, walk away, and the run is already correctly red.
 *
 * The composed instruction text is **copied onto the run**, not referenced: instructions and
 * checkpoints are unversioned by design, so without the copy a run from six weeks ago becomes
 * unexplainable once its layers have been edited.
 */
@Injectable()
export class AgentRunService {
  private readonly log = new Logger(AgentRunService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
    // Supplies the global default judge prompt a blank `compare_prompt` falls back to, and the
    // team-wide ratio the pre-seeded rows carry in their NOT NULL `threshold` column.
    @Inject(SettingsService) private readonly settings: SettingsService,
    // Composes the three AI Instructions layers — suite, test, checkpoint. Shared with the
    // author's preview endpoint on purpose: a preview assembled by a second code path is a
    // preview of a different document, and previewing exists precisely because three layers
    // assembled out of sight are what produce a baffling run an hour later.
    @Inject(AgentInstructionsService) private readonly instructions: AgentInstructionsService,
  ) {}

  /** Open a session on an Agent-Driven Test against an environment. */
  async start(
    testId: string,
    opts: {
      environmentId?: string;
      /** Who started it — an email for a person, a `Repair Agent "…"` label for a credential. */
      actor: string;
      /** Which issuer that actor came from, so the run records HOW it was triggered and not just
       *  by whom. A drainer's run is a deliberately-granted machine action, and filing it under
       *  `manual` would bury the one thing the run capability exists to make visible. */
      actorKind: "user" | "agent";
    },
  ): Promise<AgentRunSession> {
    const id = (testId ?? "").trim();
    if (!id) {
      throw new BadRequestException(
        "start_agent_run needs a testId — the id in the test's web-app URL.",
      );
    }

    const [test] = await this.db
      .select({
        id: tests.id,
        name: tests.name,
        kind: tests.kind,
        intent: tests.intent,
        leaseSeconds: tests.agentLeaseSeconds,
      })
      .from(tests)
      .where(eq(tests.id, id))
      .limit(1);
    if (!test) throw new NotFoundException(`Test ${id} not found`);
    if (test.kind !== "agent") {
      // A pinned test is behaviour written down as data: the worker replays its steps with no
      // model call, and an agent re-deciding that path each run is the silent-skipping failure
      // ADR 0004 refused. Run it with `run_test` instead.
      throw new BadRequestException(
        `"${test.name}" is a pinned test — it has recorded steps that Varys replays itself, and an agent must not re-walk them. Use run_test for this one; start_agent_run is only for Agent-Driven Tests.`,
      );
    }

    const checkpoints = await this.db
      .select()
      .from(agentCheckpoints)
      .where(eq(agentCheckpoints.testId, id))
      .orderBy(asc(agentCheckpoints.position));
    if (checkpoints.length === 0) {
      // Refused rather than started. Such a run would derive `failed` anyway (nothing was
      // verified), but a red that says "this test asks for nothing" is indistinguishable from a
      // red about the app — and the agent would be handed an empty Manifest and asked to walk it.
      throw new BadRequestException(
        `"${test.name}" has no checkpoints, so there is nothing for this run to reach or compare. Add at least one checkpoint to the test in Varys first.`,
      );
    }

    const env = await this.instructions.resolveEnvironment(opts.environmentId);

    const [version] = await this.db
      .select({ id: testVersions.id, definition: testVersions.definition })
      .from(testVersions)
      .where(eq(testVersions.testId, id))
      .orderBy(desc(testVersions.version))
      .limit(1);
    if (!version) throw new NotFoundException(`Test ${id} has no version row`);
    // The stub version's viewport, so a baseline seeded by approving one of these captures is
    // keyed exactly as the next session looks it up. Nothing honours it as a capture setting —
    // Varys does not perform the capture — but the two sides must agree on the key.
    const vpKey = viewportKeyOf((version.definition as TestDefinition).viewport);

    const comparison = await this.settings.getImageComparison();

    // Suite layer, then test layer, then each checkpoint's own — concatenated, never overridden.
    // `slots` comes back from the same call so the Manifest and the document cannot disagree
    // about what a blank comparison prompt fell back to.
    const { instructions, slots } = await this.instructions.compose({
      testId: id,
      testName: test.name,
      testInstructions: test.intent ?? "",
      environment: env.name,
      baseUrl: env.baseUrl,
      checkpoints,
    });

    // Everything that makes this run red is written here, in ONE transaction, before the tool
    // returns — so there is no instant at which a run exists without its Manifest rows.
    const seededAt = Date.now();
    // The bound, stamped once and absolutely. Taken off the test at THIS instant and copied onto
    // the run, so editing the test's lease afterwards changes what the next session gets and never
    // what this one was given.
    const leaseSeconds = test.leaseSeconds;
    const leaseExpiresAt = new Date(seededAt + leaseSeconds * 1000);
    const runId = await this.db.transaction(async (tx) => {
      const [run] = await tx
        .insert(runs)
        .values({
          testVersionId: version.id,
          environmentId: env.id,
          status: "failed",
          // Red from the outset, and truthfully so: nothing has been reached yet. This is not a
          // placeholder awaiting a reconciliation pass — it is the answer to "what did this run
          // verify?" at every instant until a slot is actually filled.
          failureKind: "unreached",
          triggeredBy: opts.actor,
          triggerSource: opts.actorKind === "agent" ? "api" : "manual",
          agentInstructions: instructions,
          agentLeaseSeconds: leaseSeconds,
          agentLeaseExpiresAt: leaseExpiresAt,
        })
        .returning({ id: runs.id });

      await tx.insert(runResults).values(
        checkpoints.map((c, i) => ({
          runId: run.id,
          checkpointName: c.name,
          reviewState: "missing",
          // `threshold` is NOT NULL and this kind never pixel-diffs — the comparison is always
          // contextual. The team-wide default is carried rather than a magic number, so the
          // column reads as "the prevailing setting", not as a decision about this run.
          threshold: comparison.ratio,
          // Stamped one millisecond apart, in Manifest order, rather than letting all of them
          // take the statement's single `now()`. `created_at` is what every reader already sorts
          // run results by — including the run view — and a batch insert would otherwise hand
          // back the journey in whatever order the rows happened to come out of the table.
          //
          // It records journey order on the RUN, which is the point: the Manifest is a property
          // of the run, so re-deriving the sequence later from `agent_checkpoints` would let an
          // edit to the test silently reorder the history of a run that walked it.
          createdAt: new Date(seededAt + i),
        })),
      );
      return run.id;
    });

    const images = await this.readBaselines(id, env.name, vpKey, checkpoints.map((c) => c.name));
    const withBaseline = new Set(images.map((b) => b.name));

    this.log.log(
      `start_agent_run: run ${runId} of "${test.name}" on ${env.name} — ${checkpoints.length} slot(s) seeded missing, ${images.length} baseline(s) supplied`,
    );

    return {
      runId,
      testId: id,
      testName: test.name,
      environment: env.name,
      environmentId: env.id,
      baseUrl: env.baseUrl || null,
      instructions,
      manifest: slots.map((s) => ({ ...s, hasBaseline: withBaseline.has(s.name) })),
      baselineImages: images.map((b) => b.name),
      leaseSeconds,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      path: `/runs/${runId}`,
      note: noteFor(test.name, slots.length, withBaseline.size, leaseSeconds),
      images,
    };
  }

  /**
   * Fill one Checkpoint Manifest slot: the capture, the verdict, and the reasoning behind it.
   *
   * The slot is looked up among the run's OWN pre-seeded rows, which is what makes the Manifest a
   * closed set in practice rather than in principle — an agent cannot invent a slot, and equally
   * cannot be tripped up by a checkpoint added to the test after its session began.
   *
   * Two things are refused, and both are refusals about honesty rather than hygiene:
   *  - **no reasoning** — the session that drove is the session that judges, holding both images,
   *    so the rationale is the entire audit trail. A verdict without one is an unfalsifiable
   *    claim, and this is the compensating control the whole comparison design rests on.
   *  - **a name outside the Manifest** — free naming is what would otherwise make a test red
   *    forever when run 7 reports `Dashboard loaded` where run 1 reported `dashboard-empty`.
   *
   * And one thing is quietly overruled: a `pass` on a slot with no approved baseline lands as
   * `pending-baseline` whatever the verdict said. There was nothing to compare against, so the
   * verdict is inert — a first run cannot be talked into reporting success.
   */
  async submitCheckpoint(
    input: {
      runId: string;
      name: string;
      verdict: AgentVerdict;
      /** Why the verdict is what it is. Required, and stored as the checkpoint's judge reasoning. */
      reasoning: string;
      capture?: AgentCaptureMeta;
    } & ImageArg,
    ctx: CallerContext,
  ): Promise<AgentSubmitResult> {
    const session = await this.openRun(input.runId);
    const name = (input.name ?? "").trim();
    const reasoning = (input.reasoning ?? "").trim();
    if (!reasoning) {
      throw new BadRequestException(
        "submit_checkpoint needs `reasoning` — say what you compared and why the verdict is what it is. Varys did not watch you drive and cannot see either image the way you can, so your rationale is the only record of how this was judged. A verdict on its own is not reviewable.",
      );
    }
    if (input.verdict !== "pass" && input.verdict !== "fail") {
      throw new BadRequestException(
        `submit_checkpoint needs \`verdict\` to be "pass" or "fail" — got ${JSON.stringify(input.verdict)}.`,
      );
    }

    const slot = session.slots.find((s) => s.checkpointName === name);
    if (!slot) {
      throw new BadRequestException(
        `"${name}" is not a slot of this run's Checkpoint Manifest. The Manifest is a CLOSED set and this run's slots are: ${session.slots
          .map((s) => `"${s.checkpointName}"`)
          .join(", ")}. Submit under one of those names exactly — do not invent, rename or merge them. If none of them describes what you reached, that is a finding to report to the user, not a name to make up.`,
      );
    }

    // A slot is filled ONCE, and this is a rule rather than a request — the tool description asks
    // for the same thing, but ADR 0006's governing principle is that nothing which must hold is
    // asked of the model. Two distinct things go wrong without it, and both turn a run greener
    // than it earned:
    //
    //  - **A verdict becomes a draft.** A `fail` against an approved baseline lands as `diff`; a
    //    second submission saying `pass` would flip the same row to `passed` and move the run from
    //    `regression` to a clean green. Re-rolling a failed verdict until it agrees hides the exact
    //    regression the checkpoint exists to catch, which the PRD rules out for assertions in the
    //    same words.
    //  - **An approved golden gets rewritten.** `approve` promotes this run's `actual_artifact_key`
    //    into `baselines` BY REFERENCE, so once a human approves a slot mid-session the baseline
    //    row points at exactly the key below. Writing it again would replace the bytes of an
    //    approved baseline with a picture nobody approved — the agent performing, through a side
    //    effect, the one act it is never allowed to perform.
    //
    // Re-walking is a new run, not an edit of this one: a fresh run is a clean record, where a
    // revised one is a record that changed after the fact.
    if (slot.reviewState !== "missing") {
      throw new BadRequestException(
        `"${name}" has already been reported on this run (it is ${slot.reviewState}${slot.resolution ? `, and a human has ${slot.resolution} it` : ""}), and a Manifest slot is filled exactly once. Your verdict on it stands as evidence and is not a draft to revise — if you believe you got it wrong, or the state has changed, start a new run with start_agent_run and walk it again. Do not re-capture this slot hoping for a different answer.`,
      );
    }

    const bytes = decodePng(input, "submit_checkpoint", ctx);
    const actualKey = `runs/${session.runId}/${artifactSegment(name)}.png`;
    await this.storage.put(actualKey, bytes);

    // The golden this capture is judged against, looked up under exactly the key `approve` writes.
    // Its mere EXISTENCE is what decides the review state — the verdict only gets a say once
    // there is something for it to have been a verdict about.
    const [baseline] = await this.db
      .select({ artifactKey: baselines.artifactKey })
      .from(baselines)
      .where(
        and(
          eq(baselines.testId, session.testId),
          eq(baselines.checkpointName, name),
          eq(baselines.environment, session.environment),
          eq(baselines.viewportKey, session.viewportKey),
        ),
      )
      .limit(1);

    const reviewState: ReviewState = !baseline
      ? "pending-baseline"
      : input.verdict === "pass"
        ? "passed"
        : "diff";

    await this.db
      .update(runResults)
      .set({
        reviewState,
        actualArtifactKey: actualKey,
        baselineArtifactKey: baseline?.artifactKey ?? null,
        judgeReasoning: reasoning,
        captureTool: trimOrNull(input.capture?.tool),
        captureViewport: trimOrNull(input.capture?.viewport),
        captureDeviceScale:
          typeof input.capture?.deviceScale === "number" && Number.isFinite(input.capture.deviceScale)
            ? input.capture.deviceScale
            : null,
      })
      .where(eq(runResults.id, slot.id));

    const state = await this.reconcileRunStatus(session.runId);
    const remaining = state.slots.filter((s) => s.reviewState === "missing").map((s) => s.name);
    return {
      runId: session.runId,
      checkpoint: name,
      verdict: input.verdict,
      hadBaseline: Boolean(baseline),
      reviewState,
      remaining,
      note: submitNoteFor(name, input.verdict, Boolean(baseline), remaining),
    };
  }

  /**
   * Attach an extra screenshot to the run — unnamed, unlimited, keying no baseline.
   *
   * "I could not find the filter, here is what the page looked like" is precisely what a reviewer
   * needs in order to tell a broken app from a wrong instruction, and nothing about the closed
   * Manifest requires forbidding it. Namelessness is what keeps the two apart: evidence cannot be
   * mistaken for a slot, promoted to a baseline, or counted toward what the run verified.
   */
  async submitEvidence(
    input: { runId: string; note?: string } & ImageArg,
    ctx: CallerContext,
  ): Promise<{ runId: string; attached: number; note: string }> {
    const session = await this.openRun(input.runId);
    const bytes = decodePng(input, "submit_evidence", ctx);
    // Keyed by a fresh uuid rather than by position: evidence is unlimited and unordered-by-name,
    // and a counter would collide the moment two attachments raced.
    const key = `runs/${session.runId}/evidence/${randomUUID()}.png`;
    await this.storage.put(key, bytes);
    await this.db
      .insert(runEvidence)
      .values({ runId: session.runId, artifactKey: key, note: (input.note ?? "").trim() });

    const attached = await this.db
      .select({ id: runEvidence.id })
      .from(runEvidence)
      .where(eq(runEvidence.runId, session.runId));
    return {
      runId: session.runId,
      attached: attached.length,
      note: "Attached as run evidence. It keys no baseline and fills no Manifest slot — a slot is only filled by submit_checkpoint under one of the Manifest's own names.",
    };
  }

  /**
   * Close the session with the agent's written account of it.
   *
   * Finishing does NOT decide the outcome, and that separation is the point: the run's status is
   * rolled up from its rows, which were being kept honest on every submission anyway, so an agent
   * that never reaches this call has already left a correct run behind. What finishing adds is the
   * narrative — the one part of the session Varys could not observe and cannot reconstruct.
   */
  async finish(input: { runId: string; summary: string }): Promise<AgentFinishResult> {
    const session = await this.openRun(input.runId);
    const summary = (input.summary ?? "").trim();
    if (!summary) {
      throw new BadRequestException(
        "finish_agent_run needs a `summary` — your account of what happened, in your own words. Varys watched none of this session, so an empty summary means a run whose only story is its rows. Say what you did, what surprised you, and anything you could not reach.",
      );
    }

    const state = await this.reconcileRunStatus(session.runId);
    await this.db
      .update(runs)
      .set({ agentSummary: summary, updatedAt: new Date() })
      .where(eq(runs.id, session.runId));

    const outcome = deriveRunOutcome(
      state.slots.map((s) => ({ reviewState: s.reviewState, resolution: s.resolution })),
      { status: state.status },
    );
    this.log.log(
      `finish_agent_run: run ${session.runId} finished — ${outcome} (${state.status}${state.failureKind ? `/${state.failureKind}` : ""})`,
    );
    return {
      runId: session.runId,
      outcome,
      status: state.status,
      failureKind: state.failureKind,
      checkpoints: state.slots.map((s) => ({ name: s.name, reviewState: s.reviewState })),
      unreached: state.slots.filter((s) => s.reviewState === "missing").map((s) => s.name),
      path: `/runs/${session.runId}`,
      note: finishNoteFor(outcome, state.slots),
    };
  }

  /**
   * Load a run this session may still write to, refusing the four ways it could be the wrong one.
   *
   * The kind check is the load-bearing one. Without it these tools would accept a PINNED run's id
   * and overwrite a checkpoint Varys captured itself with a picture an agent supplied — which,
   * once approved, becomes that test's golden. Nothing else in the feature would notice.
   *
   * The LEASE check is the one that closes a session nobody closed. Every writing tool goes
   * through here, so expiry is enforced at the one place a write can enter rather than at three,
   * and it is checked lazily on that write rather than swept for: the run has been
   * `failed`/`unreached` since its rows were seeded, so an expired session needs no reconciliation
   * pass to already be correctly red. Nothing has to run for the bound to hold — which is the same
   * property the pre-seeded rows have, and for the same reason.
   */
  private async openRun(runId: string): Promise<{
    runId: string;
    testId: string;
    environment: string;
    viewportKey: string;
    slots: {
      id: string;
      checkpointName: string;
      reviewState: string;
      resolution: string | null;
    }[];
  }> {
    const id = (runId ?? "").trim();
    if (!id) throw new BadRequestException("This needs the `runId` start_agent_run gave you.");
    const [row] = await this.db
      .select({
        runId: runs.id,
        environmentId: runs.environmentId,
        agentSummary: runs.agentSummary,
        leaseSeconds: runs.agentLeaseSeconds,
        leaseExpiresAt: runs.agentLeaseExpiresAt,
        testId: tests.id,
        testName: tests.name,
        kind: tests.kind,
        definition: testVersions.definition,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(tests, eq(tests.id, testVersions.testId))
      .where(eq(runs.id, id))
      .limit(1);
    if (!row) throw new NotFoundException(`Run ${id} not found`);
    if (row.kind !== "agent") {
      throw new BadRequestException(
        `Run ${id} is a run of "${row.testName}", a pinned test — Varys captured those checkpoints itself, and nothing may overwrite them with a submitted picture. These tools only address an Agent Run Session started with start_agent_run.`,
      );
    }
    if (row.agentSummary != null) {
      throw new BadRequestException(
        `Run ${id} was already finished — its summary is written and the run is closed. A finished session cannot be revised: if there is more to say, start a new run rather than editing the record of this one.`,
      );
    }

    // The wall-clock lease. `finish_agent_run` is refused along with the two submissions, and that
    // is deliberate rather than strict: a summary written after the bound would make the run read
    // as a session that got to the end and reported, which is precisely the state the run view has
    // to keep distinct from one that ran out of time. The agent still has somewhere to put its
    // account of it — the reply below is what it reports to the person who asked for the run.
    //
    // What this bounds is one SESSION. Nothing here stops an agent calling `start_agent_run` again
    // and drawing a fresh lease, and the closing sentence of the message below is advice rather
    // than a rule — which, by ADR 0006, means it is not load-bearing and must not be treated as
    // though it were. A bound on the sequence of sessions is a different decision (how many, over
    // what window, and how not to refuse the legitimate re-run of someone who just fixed their
    // instructions) and is deliberately not taken here.
    if (deriveAgentSessionState(
      { summaryWritten: false, leaseExpiresAt: row.leaseExpiresAt },
      Date.now(),
    ) === "expired") {
      throw new BadRequestException(
        `Run ${id} is over: its Agent Run Session was bounded by a wall-clock lease of ${describeLease(row.leaseSeconds ?? 0)}, which ran out at ${row.leaseExpiresAt?.toISOString()}. The session is closed and nothing further can be recorded against it — whatever was reported before then stands, and whatever was not is what this run verified. This is a finding, not an error: an agent that drove for the whole lease and could not reach a state has learned something real about the app or about the instructions. Take it back to the person who asked for this run — what you got to, what you could not reach, and what you think is in the way — and let them decide whether to widen the lease, fix the instructions, or look at the app. Starting another run immediately would spend their quota again on the state you already know you cannot reach.`,
      );
    }

    const slots = await this.db
      .select({
        id: runResults.id,
        checkpointName: runResults.checkpointName,
        reviewState: runResults.reviewState,
        resolution: runResults.resolution,
      })
      .from(runResults)
      .where(eq(runResults.runId, id))
      .orderBy(asc(runResults.createdAt));

    return {
      runId: row.runId,
      testId: row.testId,
      environment: (await this.environmentNameOf(row.environmentId)) ?? NO_ENVIRONMENT,
      viewportKey: viewportKeyOf((row.definition as TestDefinition).viewport),
      slots,
    };
  }

  /**
   * Re-derive `runs.status` and `failure_kind` from the run's rows.
   *
   * Run after EVERY submission, not only on finish, and that is deliberate. If the stored status
   * were only corrected when the agent closed the session, a run whose every slot was reported by
   * an agent that then crashed would sit at `failed`/`unreached` while its rows said otherwise —
   * a red that is no longer true, which is as much a misreport as a green that never was. Doing it
   * per submission keeps the column an answer to "what do the rows say?" at every instant, and
   * leaves finishing free to be about the narrative.
   *
   * The rollup itself is {@link rollupRunStatus}, shared with the human review path.
   */
  private async reconcileRunStatus(runId: string): Promise<{
    status: string;
    failureKind: RunFailureKind | null;
    slots: { name: string; reviewState: ReviewState; resolution: Resolution | null }[];
  }> {
    const rows = await this.db
      .select({
        name: runResults.checkpointName,
        reviewState: runResults.reviewState,
        resolution: runResults.resolution,
        createdAt: runResults.createdAt,
      })
      .from(runResults)
      .where(eq(runResults.runId, runId))
      .orderBy(asc(runResults.createdAt));

    const slots = rows.map((r) => ({
      name: r.name,
      reviewState: r.reviewState as ReviewState,
      resolution: r.resolution as Resolution | null,
    }));
    const status = rollupRunStatus(slots);
    // `unreached` belongs to unfilled slots specifically, not to every way the rollup can go red:
    // a run failing because a human rejected a capture is a different fact with a different owner,
    // and labelling it `unreached` would send it to the wrong place in every filter that reads it.
    const failureKind: RunFailureKind | null = slots.some((s) => s.reviewState === "missing")
      ? "unreached"
      : null;
    await this.db
      .update(runs)
      .set({ status, failureKind, updatedAt: new Date() })
      .where(eq(runs.id, runId));
    return { status, failureKind, slots };
  }

  /** An environment's name by id — `null` for an env-less run. */
  private async environmentNameOf(environmentId: string | null): Promise<string | null> {
    if (!environmentId) return null;
    const [env] = await this.db
      .select({ name: environments.name })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .limit(1);
    return env?.name ?? null;
  }

  /**
   * The environment this run targets. An unknown id is REFUSED rather than degraded to the
   * env-less default: baselines are keyed by environment name, so quietly falling back would
   * compare a staging capture against production's golden and call the difference a regression.
   */


  /** The approved baseline PNG for each slot that has one, as base64, in Manifest order. */
  private async readBaselines(
    testId: string,
    environment: string,
    viewportKey: string,
    names: string[],
  ): Promise<{ name: string; data: string }[]> {
    const rows = await this.db
      .select({ name: baselines.checkpointName, artifactKey: baselines.artifactKey })
      .from(baselines)
      .where(
        and(
          eq(baselines.testId, testId),
          inArray(baselines.checkpointName, names),
          eq(baselines.environment, environment),
          eq(baselines.viewportKey, viewportKey),
        ),
      );
    const keyByName = new Map(rows.map((r) => [r.name, r.artifactKey]));

    // Walked in MANIFEST order rather than query order, because the images ride back as an
    // ordered list of content blocks whose only label is `baselineImages`.
    const out: { name: string; data: string }[] = [];
    for (const name of names) {
      const artifactKey = keyByName.get(name);
      if (!artifactKey) continue;
      const bytes = await this.storage.get(artifactKey);
      if (!bytes) {
        // The row says a golden was approved and the bytes are gone. Reported as "no baseline"
        // rather than silently skipped: comparing against nothing is the correct behaviour, and
        // the log is where an operator finds out storage lost something.
        this.log.warn(`baseline artifact ${artifactKey} missing for ${testId}/${name}`);
        continue;
      }
      out.push({ name, data: bytes.toString("base64") });
    }
    return out;
  }
}

/**
 * What the run's state means right now, in the terms the agent has to report it in.
 *
 * Prose rather than a status string because the thing most easily misreported is the one that
 * looks like progress: a session that has STARTED has verified nothing, and the run is already
 * failed. Saying so up front is what stops "I've begun the run" being relayed as "the run is
 * under way and looking fine".
 *
 * It names the reporting tools explicitly, because the failure this text exists to prevent is an
 * agent that drives well and then reports nothing: a slot is only filled by the call that fills
 * it, and there is no other way for good work to reach the run.
 */
function noteFor(
  testName: string,
  slotCount: number,
  withBaseline: number,
  leaseSeconds: number,
): string {
  const seeded = `This run is ALREADY FAILED, with reason \`unreached\` — all ${slotCount} Checkpoint Manifest slot(s) of "${testName}" are seeded as missing, and each stays that way until it is actually reported. If you stop here, crash, or lose the connection, the run stays exactly this red; nothing infers anything from work you did but did not report.`;
  const closed =
    "The Manifest is a CLOSED set: those names are the only ones this run can ever be reported under, so do not invent, rename or merge them.";
  const baseline =
    withBaseline === 0
      ? "No slot has an approved baseline in this environment yet, so nothing here can pass on its own: every capture goes to a human for approval first."
      : `${withBaseline} slot(s) have an approved baseline attached below as images — compare against those, and remember the rest have none, so their captures await a human's approval rather than passing.`;
  const driving =
    "How you reach each state is yours to decide: Varys drives no browser for this kind and does not watch how you get there. Follow the instructions above.";
  const reporting =
    "Report each slot with submit_checkpoint (its Manifest name, your screenshot, a pass/fail verdict and your reasoning — reasoning is required), attach anything else worth seeing with submit_evidence, and close with finish_agent_run and your account of the session. Nothing you do outside those calls reaches the run.";
  // Said plainly rather than left to be discovered by a refusal. Retrying is the agent's own
  // business and nothing here is asking it to stop — but an agent that knows its remaining time
  // can spend it on the checkpoint most likely to be reachable instead of on the one it is stuck
  // against, and can report what it did not get to rather than being cut off mid-thought.
  const lease = `This session is bounded by a server-side wall-clock lease of ${describeLease(leaseSeconds)}, starting now. Varys enforces it; it is not something the instructions can extend. When it runs out the session is CLOSED — submit_checkpoint, submit_evidence and finish_agent_run all stop being accepted, and whatever is still unreported is what this run verified. Retrying a state you could not reach is entirely your call, but budget against that clock: if a state is not going to appear, the honest red is the finding.`;
  return `${seeded} ${closed} ${baseline} ${driving} ${reporting} ${lease}`;
}

/** Trimmed, or null when there was nothing there — capture metadata is optional at every field. */
function trimOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/**
 * A checkpoint name, made safe to use as one path segment WITHOUT losing which name it was.
 *
 * Percent-escaping rather than collapsing unsafe characters to `_`, because collapsing is not
 * injective: `"cart/empty"` and `"cart empty"` would land on the same key, and one slot would
 * silently show the other's picture. A wrong image under a right name is the single most
 * misleading thing this feature could produce.
 */
function artifactSegment(name: string): string {
  return name.replace(
    /[^A-Za-z0-9._-]/g,
    (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/**
 * What was actually recorded for a slot, said plainly enough that it cannot be relayed as
 * something better.
 *
 * The `pass`-with-no-baseline case is the whole reason this text exists. An agent that compared
 * carefully, was satisfied, and said `pass` has done nothing wrong — but there was no golden to
 * compare against, so what it produced is a proposal awaiting a human, and "I passed that
 * checkpoint" is the one summary of it that would be false.
 */
function submitNoteFor(
  name: string,
  verdict: AgentVerdict,
  hadBaseline: boolean,
  remaining: string[],
): string {
  const recorded = !hadBaseline
    ? `Recorded as **pending-baseline**: "${name}" has no approved baseline in this environment, so there was nothing for a verdict to be about and yours does not change the state. Your capture is now a PROPOSAL awaiting a human's approval — do not report this slot as passing, however confident the comparison felt.`
    : verdict === "pass"
      ? `Recorded as **passed**: it matched its approved baseline.`
      : `Recorded as **diff**: it differs from its approved baseline. That verdict stands as evidence about the application and nothing retries it — not Varys, and not you. Do not re-capture this slot hoping for a better answer.`;
  const left =
    remaining.length === 0
      ? "Every Manifest slot is now filled. Call finish_agent_run with your account of the session."
      : `Still unfilled, so the run is still red: ${remaining.map((r) => `"${r}"`).join(", ")}.`;
  return `${recorded} ${left}`;
}

/** How to report the finished run — in the outcome's own words, since three of them are not passes. */
function finishNoteFor(
  outcome: RunOutcome,
  slots: { name: string; reviewState: ReviewState }[],
): string {
  const unreached = slots.filter((s) => s.reviewState === "missing").map((s) => s.name);
  switch (outcome) {
    case "failed":
      return unreached.length > 0
        ? `This run is FAILED because ${unreached.length} Manifest slot(s) were never filled: ${unreached
            .map((u) => `"${u}"`)
            .join(", ")}. Report it that way. If they went unfilled because you could not reach them, the honest red IS the finding — say what stopped you, and do not describe the run as partially successful.`
        : "This run is FAILED. Report it as such, with what you saw.";
    case "pending-baseline":
      return "This run VERIFIED NOTHING: every capture is a first one, with no approved baseline behind it. It is not a pass, and it is not a failure — a human must approve the captures in Needs review before any future run can compare against them. Report it as captures awaiting approval.";
    case "regression":
      return "This run found a REGRESSION: a capture differs from its approved baseline. That is evidence about the application and a human decides what it means. Nothing retries it, and it must not be re-captured until it agrees.";
    case "baseline":
      return "Baselines were written by this run. It verified nothing by doing so.";
    default:
      return `Report this run as ${outcome}.`;
  }
}
