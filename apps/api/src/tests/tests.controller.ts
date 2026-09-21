import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from "@nestjs/common";
import type {
  AgentCheckpointInput,
  CreateAgentTestRequest,
  LocatorVerifyRequest,
  ReorderAgentCheckpointsRequest,
  TestConfigPatch,
} from "@varys/review-contract";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { AgentInstructionsService } from "./agent-instructions.service";
import { AgentTestsService } from "./agent-tests.service";
import { LocatorVerifyService } from "./locator-verify.service";
import { TestsService, type UpdateTestInput } from "./tests.service";

@Controller("tests")
export class TestsController {
  // Explicit tokens so DI works without emitted decorator metadata.
  constructor(
    @Inject(TestsService) private readonly tests: TestsService,
    @Inject(LocatorVerifyService) private readonly locatorVerify: LocatorVerifyService,
    @Inject(AgentTestsService) private readonly agent: AgentTestsService,
    @Inject(AgentInstructionsService) private readonly instructions: AgentInstructionsService,
  ) {}

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.tests.create(body, user.email);
  }

  @Get()
  list() {
    return this.tests.list();
  }


  // Create an Agent-Driven Test: no steps, active on create, no Draft and no Promote.
  // Declared before the `:id` routes so "agent" is never read as a test id.
  @Post("agent")
  createAgentTest(@Body() body: CreateAgentTestRequest, @CurrentUser() user: AuthUser) {
    return this.agent.create(body ?? ({} as CreateAgentTestRequest), user.email);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.tests.getById(id);
  }

  // The editable config surface (waits + threshold) of the test's definition.
  @Get(":id/config")
  getConfig(@Param("id") id: string) {
    return this.tests.getConfig(id);
  }

  // Apply a config patch onto the test's definition. 409 on a stale `baseUpdatedAt`.
  @Put(":id/config")
  saveConfig(@Param("id") id: string, @Body() body: TestConfigPatch, @CurrentUser() user: AuthUser) {
    return this.tests.saveConfig(id, body, user.email);
  }

  // Live-verify a candidate (unsaved) locator at one step against a chosen environment, via
  // a transient partial replay. Persists nothing; 409 if superseded by a newer verify.
  @Post(":id/config/verify")
  @HttpCode(200) // a probe — resolves nothing, persists nothing
  verifyLocator(@Param("id") id: string, @Body() body: LocatorVerifyRequest) {
    return this.locatorVerify.verify(id, body);
  }

  // Relational metadata only ({ name?, folderId? — null unfiles, tags?, schedule? });
  // never the definition itself. The actor owns any cron schedule set.
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateTestInput, @CurrentUser() user: AuthUser) {
    return this.tests.update(id, body ?? {}, user.email);
  }

  // Hard-delete: removes the test and ALL its runs, baselines, and history. No rollback.
  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.tests.delete(id);
  }

  // The three layers of AI Instructions — suite, test, checkpoint — composed exactly as
  // start_agent_run would compose them, so an author can read what the agent will be told before
  // spending a Claude subscription to find out. Read-only: it starts nothing and writes nothing.
  @Get(":id/agent-instructions")
  previewInstructions(@Param("id") id: string, @Query("environmentId") environmentId?: string) {
    return this.instructions.preview(id, environmentId);
  }

  /* ---- Agent-Driven Test checkpoints -------------------------------------------------- *
   * The ordered Checkpoint Manifest. Edited in place, like everything else about a test. */

  @Get(":id/agent-checkpoints")
  listCheckpoints(@Param("id") id: string) {
    return this.agent.listCheckpoints(id);
  }

  @Post(":id/agent-checkpoints")
  addCheckpoint(@Param("id") id: string, @Body() body: AgentCheckpointInput) {
    return this.agent.addCheckpoint(id, body ?? {});
  }

  // Declared before the `:checkpointId` routes so "reorder" is never read as a checkpoint id.
  @Post(":id/agent-checkpoints/reorder")
  @HttpCode(200) // permutes existing rows; creates nothing
  reorderCheckpoints(@Param("id") id: string, @Body() body: ReorderAgentCheckpointsRequest) {
    return this.agent.reorder(id, body?.ids ?? []);
  }

  // What a delete would cost, asked BEFORE it happens: which environments lose an approved
  // baseline. The editor shows this in its confirm rather than deleting and reporting after.
  @Get(":id/agent-checkpoints/:checkpointId/delete-impact")
  checkpointDeleteImpact(@Param("id") id: string, @Param("checkpointId") checkpointId: string) {
    return this.agent.deleteImpact(id, checkpointId);
  }

  // A rename here carries the checkpoint's approved baselines in every environment.
  @Patch(":id/agent-checkpoints/:checkpointId")
  updateCheckpoint(
    @Param("id") id: string,
    @Param("checkpointId") checkpointId: string,
    @Body() body: AgentCheckpointInput,
  ) {
    return this.agent.updateCheckpoint(id, checkpointId, body ?? {});
  }

  @Delete(":id/agent-checkpoints/:checkpointId")
  deleteCheckpoint(@Param("id") id: string, @Param("checkpointId") checkpointId: string) {
    return this.agent.deleteCheckpoint(id, checkpointId);
  }
}
