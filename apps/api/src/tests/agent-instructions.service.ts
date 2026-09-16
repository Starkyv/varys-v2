import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  agentCheckpoints,
  environments,
  suites,
  suiteTests,
  tests,
} from "@varys/db";
import {
  composeAgentInstructions,
  type AgentInstructionSlot,
  type AgentInstructionsPreview,
} from "@varys/review-contract";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { SettingsService } from "../settings/settings.service";

/** The environment name a run with no environment is keyed under — the same fallback the run and
 *  baseline paths use, so a preview names the environment the session actually would. */
const NO_ENVIRONMENT = "default";

/** One Checkpoint as its layer is read off the row, before the judge-prompt fallback is applied. */
export interface CheckpointLayer {
  name: string;
  instructions: string;
  comparePrompt: string;
}

/**
 * The three layers of **AI Instructions**, gathered and composed.
 *
 * This exists as one service, rather than as code inside `AgentRunService.start`, for a single
 * reason: the author previews the composed text **before** running, and a preview assembled by a
 * second code path is a preview of a different document. The whole value of the preview is that
 * three layers assembled out of sight are what produce a baffling run an hour later — so the
 * preview has to be the same assembly, not a faithful-looking reimplementation of it.
 *
 * The composition itself is pure and lives in `@varys/review-contract`; what is here is the
 * reading — which suites contribute, and what a blank comparison prompt falls back to.
 */
@Injectable()
export class AgentInstructionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    // Supplies the global default judge prompt a blank per-checkpoint `compare_prompt` falls back
    // to. Resolved HERE rather than in the composer so the preview and the run agree even when
    // the setting is edited between them.
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  /**
   * The suite layer for a test: every suite that carries AI Instructions **and selects this test**,
   * in name order so the composed document is stable between runs.
   *
   * Membership is read off `suite_tests` — explicit membership, the same table the "an
   * Agent-Driven Test cannot join a suite" refusal guards. It is deliberately NOT the suite's
   * effective member set (which also resolves whole folders), because that set drops
   * Agent-Driven Tests by design: a suite cannot run one, so counting one as a member would
   * misreport what the suite does. Two different answers to "is this test in that suite?" is
   * exactly the kind of thing this feature exists to make visible rather than to introduce.
   *
   * The consequence today is that this returns nothing: `assertNoAgentTests` refuses an
   * Agent-Driven Test at the point of membership, so no agent test has a `suite_tests` row. The
   * layer is real, composed and stored from the moment suite membership opens up; until then the
   * suite editor says plainly that the instructions apply to nothing rather than implying they do.
   */
  async suiteLayersFor(testId: string): Promise<{ name: string; instructions: string }[]> {
    return await this.db
      .select({ name: suites.name, instructions: suites.agentInstructions })
      .from(suiteTests)
      .innerJoin(suites, eq(suites.id, suiteTests.suiteId))
      .where(and(eq(suiteTests.testId, testId), isNotNull(suites.agentInstructions)))
      .orderBy(asc(suites.name))
      .then((rows) => rows.map((r) => ({ name: r.name, instructions: r.instructions ?? "" })));
  }

  /**
   * Compose from layers the caller has already read — the path `start_agent_run` takes.
   *
   * The slots come back alongside the text because the caller needs the same judge-prompt
   * fallback for the Checkpoint Manifest it hands the agent, and resolving it twice is how the
   * Manifest and the document start disagreeing about what a slot is being compared against.
   */
  async compose(input: {
    testId: string;
    testName: string;
    testInstructions: string;
    environment: string;
    baseUrl: string;
    checkpoints: readonly CheckpointLayer[];
  }): Promise<{ instructions: string; slots: AgentInstructionSlot[]; suiteNames: string[] }> {
    const judge = await this.settings.getJudge();
    const suiteLayers = await this.suiteLayersFor(input.testId);

    const slots: AgentInstructionSlot[] = input.checkpoints.map((c, i) => ({
      step: i + 1,
      name: c.name,
      instructions: c.instructions,
      comparePrompt: c.comparePrompt.trim() || judge.defaultPrompt,
    }));

    return {
      instructions: composeAgentInstructions({
        testName: input.testName,
        environment: input.environment,
        baseUrl: input.baseUrl,
        suites: suiteLayers,
        testInstructions: input.testInstructions,
        slots,
      }),
      slots,
      // Only the suites that actually CONTRIBUTED — one whose instructions are blank is dropped
      // by the composer, and naming it here would have the preview claim a section that is not
      // in the text below it.
      suiteNames: suiteLayers.filter((s) => s.instructions.trim() !== "").map((s) => s.name),
    };
  }

  /**
   * The composed text exactly as the next session would receive it, for an author to read before
   * spending a Claude subscription on it.
   *
   * Tolerates a test with no checkpoints, where `start_agent_run` refuses one: previewing is what
   * an author does WHILE writing, and refusing to show the document until the journey is finished
   * would withhold it precisely when it is being drafted.
   */
  async preview(testId: string, environmentId?: string): Promise<AgentInstructionsPreview> {
    const [test] = await this.db
      .select({ name: tests.name, kind: tests.kind, intent: tests.intent })
      .from(tests)
      .where(eq(tests.id, testId))
      .limit(1);
    if (!test) throw new NotFoundException(`Test ${testId} not found`);
    if (test.kind !== "agent") {
      throw new NotFoundException(
        `"${test.name}" is a pinned test — it is replayed from recorded steps and is given no AI Instructions.`,
      );
    }

    const env = await this.resolveEnvironment(environmentId);
    const checkpoints = await this.db
      .select({
        name: agentCheckpoints.name,
        instructions: agentCheckpoints.instructions,
        comparePrompt: agentCheckpoints.comparePrompt,
      })
      .from(agentCheckpoints)
      .where(eq(agentCheckpoints.testId, testId))
      .orderBy(asc(agentCheckpoints.position));

    const composed = await this.compose({
      testId,
      testName: test.name,
      testInstructions: test.intent ?? "",
      environment: env.name,
      baseUrl: env.baseUrl,
      checkpoints,
    });

    return {
      instructions: composed.instructions,
      suites: composed.suiteNames,
      environment: env.name,
      checkpointCount: checkpoints.length,
    };
  }

  /**
   * The environment a session or a preview is composed against, or the `default` fallback when
   * there is none.
   *
   * Public and shared with `AgentRunService` rather than copied into it, for the same reason the
   * composition itself is shared: the environment NAME and base URL are written into the document,
   * so two resolvers that drifted apart would make a preview describe a different app from the run
   * it is previewing. One answer, one place.
   */
  async resolveEnvironment(
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
}
