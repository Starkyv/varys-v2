import { Module } from "@nestjs/common";
import { RunsModule } from "../runs/runs.module";
import { SuiteRunsController } from "./suite-runs.controller";
import { SuiteRunsService } from "./suite-runs.service";

@Module({
  // RunsModule: children are created through the existing single-run path.
  imports: [RunsModule],
  controllers: [SuiteRunsController],
  providers: [SuiteRunsService],
  // Exported so the suites controller can host the trigger route.
  exports: [SuiteRunsService],
})
export class SuiteRunsModule {}
