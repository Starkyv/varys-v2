import { Module } from "@nestjs/common";
import { AgentTestsService } from "./agent-tests.service";
import { DraftsController } from "./drafts.controller";
import { LocatorVerifyService } from "./locator-verify.service";
import { TagsController } from "./tags.controller";
import { TestsController } from "./tests.controller";
import { TestsService } from "./tests.service";

@Module({
  controllers: [TestsController, TagsController, DraftsController],
  providers: [TestsService, LocatorVerifyService, AgentTestsService],
  // TestsService is exported so SuitesModule can build member TestSummary[] without duplicating
  // the needsEnvironment/folder/tags read-model; AgentTestsService so it can refuse an
  // Agent-Driven Test at the point of membership.
  exports: [TestsService, AgentTestsService],
})
export class TestsModule {}
