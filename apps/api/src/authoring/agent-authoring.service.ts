import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AgentCheckpoint } from "@varys/review-contract";
import { tests } from "@varys/db";
import { eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { AgentTestsService } from "../tests/agent-tests.service";
import { TestsService } from "../tests/tests.service";
import { decodePng, type CallerContext, type ImageArg } from "./png";

/**
 * **Claude authoring an Agent-Driven Test** — the write half of the kind whose run half is
 * {@link AgentRunService} (ticket #10).
 *
 * Claude explores the app with its own local tooling, exactly as it does during a run: Varys
 * hosts no browser here either, and supplies no perception or action tools. What it supplies is
 * somewhere to put the result, and two refusals that make that safe to offer.
 *
 * **No session object, and no finish step.** The run surface has one because the pre-seeded rows
 * must let Varys call a run red without the agent's cooperation. Authoring protects no equivalent
 * guarantee, so a session would be state held for nothing. The **Draft is the accumulator**: it is
 * in the review queue from the moment it is created, so a pass that is abandoned half way leaves a
 * visibly incomplete Draft rather than nothing at all — or, worse, a complete-looking one.
 *
 * **These are the editor's own operations, not a second way to write the same rows.** Creation and
 * checkpoint insertion both go through {@link AgentTestsService}, so the unique index on
 * `(test_id, name)` — which the Checkpoint Manifest's closed-set property rests on — is enforced
 * identically whoever is writing, and the test's stub definition is written by the same code
 * that writes it for a person.
 */
@Injectable()
export class AgentAuthoringService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AgentTestsService) private readonly agentTests: AgentTestsService,
    @Inject(TestsService) private readonly testsService: TestsService,
  ) {}

  /**
   * Write the authored artifact as a Draft. `instructions` is the AI Instructions Claude wrote —
   * the thing every future run is composed from — and deliberately NOT the sentence that asked
   * for the test, which is not persisted anywhere.
   */
  async createTest(input: { name: string; instructions: string; createdBy: string }): Promise<{
    testId: string;
    name: string;
    kind: "agent";
    status: "draft";
    origin: "ai";
    checkpoints: string[];
    note: string;
  }> {
    const name = input.name?.trim();
    if (!name) {
      throw new BadRequestException(
        "create_agent_test needs a `name` — what this test is called in the Varys web app.",
      );
    }
    const instructions = input.instructions?.trim();
    if (!instructions) {
      throw new BadRequestException(
        "create_agent_test needs `instructions` — the AI Instructions a future run is driven by. Write what you learned walking the app: where it is, how to sign in, what to ignore, what never to touch. An Agent-Driven Test with no instructions is a test nobody can run.",
      );
    }

    const { id } = await this.agentTests.createDraft({ name, instructions }, input.createdBy);
    return {
      testId: id,
      name,
      kind: "agent",
      status: "draft",
      origin: "ai",
      checkpoints: [],
      note: "Draft created and already in the review queue. Add one Checkpoint per state you actually reached, each with the screenshot proving you got there — there is no finish step, so whatever you have written is what a reviewer will see. A human promotes it in the Varys web app; you cannot.",
    };
  }

  /**
   * Append one Checkpoint to a Draft, with the capture that proves the state was reached.
   *
   * Two refusals stand in front of the write, and the order they run in is the order they matter.
   *
   * **The Draft scope** comes first: once a test is promoted it is `active`, and nothing here may
   * touch it again — editing is the author's, in the editor. That one rule subsumes a second that
   * would otherwise need remembering, because a test with a live Agent Run Session is by
   * definition promoted: "the agent cannot edit the test it is running" holds structurally.
   *
   * **The required image** comes second, before any row exists. Prose describing a state Claude
   * reached and prose describing one it imagined are indistinguishable on the page; the picture is
   * the only thing that separates them. Refusing the write — rather than asking for the image in a
   * prompt — is what makes that separation real, and a refusal that left the row behind would be
   * no refusal at all.
   */
  async addCheckpoint(
    input: {
      testId: string;
      name: string;
      instructions: string;
      comparePrompt: string;
    } & ImageArg,
    ctx: CallerContext,
  ): Promise<{
    testId: string;
    checkpoint: AgentCheckpoint;
    checkpoints: string[];
    note: string;
  }> {
    const testId = input.testId?.trim();
    await this.assertWritableDraft(testId);
    // Decoded BEFORE the row is written, so a bad or absent image leaves nothing behind.
    const bytes = decodePng(input, "add_agent_checkpoint", ctx);

    const checkpoint = await this.agentTests.addCheckpoint(testId, {
      name: input.name,
      instructions: input.instructions,
      comparePrompt: input.comparePrompt,
    });
    // A reference image, never a baseline: the first Run still produces the capture a human
    // approves, per environment. Written after the row so a refused duplicate name cannot
    // overwrite the picture that already belongs to that slot.
    await this.testsService.putDraftPreview(testId, checkpoint.name, bytes);

    const checkpoints = (await this.agentTests.listCheckpoints(testId)).map((c) => c.name);
    return {
      testId,
      checkpoint,
      checkpoints,
      note: `Checkpoint ${checkpoints.length} of this journey, stored with your capture as a reference image — not a baseline. The first Run against an environment proposes the baselines, and a human approves them there.`,
    };
  }

  /**
   * The write scope, in one place: an Agent-Driven Test that is still a Draft.
   *
   * The kind check and the status check refuse for different reasons and say so differently. A
   * pinned test has its checkpoints in its recorded steps and there is nothing here to add; a
   * promoted test is in service, and its author edits it themselves.
   */
  private async assertWritableDraft(testId: string): Promise<void> {
    if (!testId) {
      throw new BadRequestException("add_agent_checkpoint needs a `testId` — the Draft to add to.");
    }
    const [row] = await this.db
      .select({ kind: tests.kind, status: tests.status, name: tests.name })
      .from(tests)
      .where(eq(tests.id, testId))
      .limit(1);
    if (!row) throw new NotFoundException(`Test ${testId} not found`);
    if (row.kind !== "agent") {
      throw new BadRequestException(
        `"${row.name}" is a pinned test — its checkpoints are recorded steps in its definition, not Checkpoints you can write. Open an authoring session on it instead.`,
      );
    }
    if (row.status !== "draft") {
      throw new BadRequestException(
        `"${row.name}" has already been promoted, so it is in service and these tools may not change it — they write only to Drafts. Create a new Draft, or ask its author to edit it in the Varys web app. (This is also why you can never edit a test you are running: a test with a live Agent Run Session is by definition promoted.)`,
      );
    }
  }
}
