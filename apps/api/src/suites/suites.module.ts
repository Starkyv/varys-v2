import { Module } from "@nestjs/common";
import { SuiteRunsModule } from "../suite-runs/suite-runs.module";
import { TestsModule } from "../tests/tests.module";
import { SuitesController } from "./suites.controller";
import { SuitesService } from "./suites.service";

@Module({
  // SuiteRunsModule: the trigger route (`POST /suites/:id/runs`) lives here.
  imports: [TestsModule, SuiteRunsModule],
  controllers: [SuitesController],
  providers: [SuitesService],
})
export class SuitesModule {}
