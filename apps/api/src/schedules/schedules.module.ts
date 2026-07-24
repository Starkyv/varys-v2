import { Module } from "@nestjs/common";
import { RunsModule } from "../runs/runs.module";
import { SuiteRunsModule } from "../suite-runs/suite-runs.module";
import { SchedulerService } from "./scheduler.service";

/** Hosts the schedule firing tick. Imports RunsModule + SuiteRunsModule to create test runs and
 *  suite runs through the same paths a manual trigger uses. DB is global (DbModule). */
@Module({
  imports: [RunsModule, SuiteRunsModule],
  providers: [SchedulerService],
})
export class SchedulesModule {}
