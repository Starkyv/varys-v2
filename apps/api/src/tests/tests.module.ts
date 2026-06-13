import { Module } from "@nestjs/common";
import { TagsController } from "./tags.controller";
import { TestsController } from "./tests.controller";
import { TestsService } from "./tests.service";

@Module({
  controllers: [TestsController, TagsController],
  providers: [TestsService],
  // Exported so SuitesModule can build member TestSummary[] without duplicating
  // the needsEnvironment/folder/tags read-model.
  exports: [TestsService],
})
export class TestsModule {}
