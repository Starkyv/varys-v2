import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  agentCheckpoints,
  baselines,
  environments,
  runResults,
  runs,
  testVersions,
  tests,
} from "../db/schema";
import type { TestDefinition } from "@varys/step-schema";
import type { StorageAdapter } from "@varys/storage-adapter";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { viewportKeyOf } from "../runs/runs.service";
import { SettingsService } from "../settings/settings.service";
import { STORAGE } from "../storage/storage.module";

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
      .select({ id: tests.id, name: tests.name, kind: tests.kind, intent: tests.intent })
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

    const env = await this.resolveEnvironment(opts.environmentId);

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

    const judge = await this.settings.getJudge();
    const comparison = await this.settings.getImageComparison();

    const slots = checkpoints.map((c, i) => ({
      step: i + 1,
      name: c.name,
      instructions: c.instructions,
      comparePrompt: c.comparePrompt.trim() || judge.defaultPrompt,
    }));

    const instructions = composeInstructions({
      testName: test.name,
      environment: env.name,
      baseUrl: env.baseUrl,
      testInstructions: test.intent ?? "",
      slots,
    });

    // Everything that makes this run red is written here, in ONE transaction, before the tool
    // returns — so there is no instant at which a run exists without its Manifest rows.
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
        })
        .returning({ id: runs.id });

      await tx.insert(runResults).values(
        checkpoints.map((c) => ({
          runId: run.id,
          checkpointName: c.name,
          reviewState: "missing",
          // `threshold` is NOT NULL and this kind never pixel-diffs — the comparison is always
          // contextual. The team-wide default is carried rather than a magic number, so the
          // column reads as "the prevailing setting", not as a decision about this run.
          threshold: comparison.ratio,
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
      path: `/runs/${runId}`,
      note: noteFor(test.name, slots.length, withBaseline.size),
      images,
    };
  }

  /**
   * The environment this run targets. An unknown id is REFUSED rather than degraded to the
   * env-less default: baselines are keyed by environment name, so quietly falling back would
   * compare a staging capture against production's golden and call the difference a regression.
   */
  private async resolveEnvironment(
    environmentId: string | undefined,
  ): Promise<{ id: string | null; name: string; baseUrl: string }> {
    const wanted = (environmentId ?? "").trim();
    if (!wanted) return { id: null, name: NO_ENVIRONMENT, baseUrl: "" };
    const [env] = await this.db
      .select({ id: environments.id, name: environments.name, baseUrl: environments.baseUrl })
      .from(environments)
      .where(eq(environments.id, wanted))
      .limit(1);
    if (!env) throw new NotFoundException(`Environment ${wanted} not found`);
    return env;
  }

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
 * The three instruction layers, flattened into the one document the agent is handed and the run
 * keeps a verbatim copy of.
 *
 * Layers are **concatenated, general → specific**, never overridden: these are additive context
 * ("here is the app" / "here is this journey" / "here is this state"), not competing settings,
 * and override semantics would need per-key structure that prose does not have. The suite layer
 * joins at the top when suite-level AI Instructions land.
 *
 * Written as a readable document rather than a JSON blob because a human reads this too — it is
 * what the run detail shows when someone asks what the agent was actually told.
 */
function composeInstructions(input: {
  testName: string;
  environment: string;
  baseUrl: string;
  testInstructions: string;
  slots: { step: number; name: string; instructions: string; comparePrompt: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${input.testName}`);
  lines.push("");
  lines.push(`Environment: ${input.environment}${input.baseUrl ? ` (${input.baseUrl})` : ""}`);
  lines.push("");

  const testLayer = input.testInstructions.trim();
  if (testLayer) {
    lines.push("## AI Instructions");
    lines.push("");
    lines.push(testLayer);
    lines.push("");
  }

  lines.push("## Checkpoints");
  lines.push("");
  lines.push(
    "Walk these in order. Each one carries on from the last, so the page is wherever the previous checkpoint left it.",
  );
  lines.push("");
  for (const slot of input.slots) {
    lines.push(`### ${slot.step}. ${slot.name}`);
    lines.push("");
    lines.push("How to get here:");
    lines.push(slot.instructions.trim() || "(not specified)");
    lines.push("");
    lines.push("What counts as matching its baseline:");
    lines.push(slot.comparePrompt.trim() || "(not specified)");
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * What the run's state means right now, in the terms the agent has to report it in.
 *
 * Prose rather than a status string because the thing most easily misreported is the one that
 * looks like progress: a session that has STARTED has verified nothing, and the run is already
 * failed. Saying so up front is what stops "I've begun the run" being relayed as "the run is
 * under way and looking fine".
 *
 * Deliberately names no reporting tool: the submit/finish surface is a later slice, and copy
 * that promises a tool the server does not register would send an agent at an Unknown tool
 * mid-run. Extend this when those tools exist.
 */
function noteFor(testName: string, slotCount: number, withBaseline: number): string {
  const seeded = `This run is ALREADY FAILED, with reason \`unreached\` — all ${slotCount} Checkpoint Manifest slot(s) of "${testName}" are seeded as missing, and each stays that way until it is actually reported. If you stop here, crash, or lose the connection, the run stays exactly this red; nothing infers anything from work you did but did not report.`;
  const closed =
    "The Manifest is a CLOSED set: those names are the only ones this run can ever be reported under, so do not invent, rename or merge them.";
  const baseline =
    withBaseline === 0
      ? "No slot has an approved baseline in this environment yet, so nothing here can pass on its own: every capture goes to a human for approval first."
      : `${withBaseline} slot(s) have an approved baseline attached below as images — compare against those, and remember the rest have none, so their captures await a human's approval rather than passing.`;
  const driving =
    "How you reach each state is yours to decide: Varys drives no browser for this kind and does not watch how you get there. Follow the instructions above.";
  return `${seeded} ${closed} ${baseline} ${driving}`;
}
