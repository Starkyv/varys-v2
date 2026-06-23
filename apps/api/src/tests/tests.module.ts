import { Module } from "@nestjs/common";
import { DraftsController } from "./drafts.controller";
import { LocatorVerifyService } from "./locator-verify.service";
import { TagsController } from "./tags.controller";
import { TestsController } from "./tests.controller";
import { TestsService } from "./tests.service";

@Module({
  controllers: [TestsController, TagsController, DraftsController],
  providers: [TestsService, LocatorVerifyService],
  // Exported so SuitesModule can build member TestSummary[] without duplicating
  // the needsEnvironment/folder/tags read-model.
  exports: [TestsService],
})
export class TestsModule {}
