import { Module } from "@nestjs/common";
import { SettingsModule } from "../settings/settings.module";
import { AgentInstructionsService } from "./agent-instructions.service";
import { AgentTestsService } from "./agent-tests.service";
import { DraftsController } from "./drafts.controller";
import { LocatorVerifyService } from "./locator-verify.service";
import { TagsController } from "./tags.controller";
import { TestsController } from "./tests.controller";
import { TestsService } from "./tests.service";

@Module({
  // SettingsModule supplies the global default judge prompt a blank per-checkpoint
  // compare_prompt falls back to when AI Instructions are composed.
  imports: [SettingsModule],
  controllers: [TestsController, TagsController, DraftsController],
  providers: [TestsService, LocatorVerifyService, AgentTestsService, AgentInstructionsService],
  // TestsService is exported so SuitesModule can build member TestSummary[] without duplicating
  // the needsEnvironment/folder/tags read-model; AgentTestsService so it can refuse an
  // Agent-Driven Test at the point of membership; AgentInstructionsService so AgentRunService
  // composes the three AI Instructions layers through the SAME path the author's preview reads.
  exports: [TestsService, AgentTestsService, AgentInstructionsService],
})
export class TestsModule {}
