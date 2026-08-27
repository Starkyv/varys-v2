import { Module } from "@nestjs/common";
import { DB, type Db } from "../db/db.module";
import { RunsModule } from "../runs/runs.module";
import { CLOCK, SYSTEM_CLOCK } from "./clock";
import { createDbJudgeSource, JUDGE_SOURCE } from "./judge";
import { RepairJobsController } from "./repair-jobs.controller";
import { RepairJobsService } from "./repair-jobs.service";
import { RepairReviewsService } from "./repair-reviews.service";

@Module({
  // RunsModule: an accepted repair triggers a RE-RUN (slice 06), created through the same
  // single-run path everything else uses (latest-version pin + enqueue) rather than a second one.
  imports: [RunsModule],
  controllers: [RepairJobsController],
  // The clock is a provider so an E2E can override it and step over a lease expiry without
  // sleeping (slice 03) — see `./clock`.
  providers: [
    RepairJobsService,
    RepairReviewsService,
    { provide: CLOCK, useValue: SYSTEM_CLOCK },
    // The justification gate's judge (slice 05), a provider for the same reason as the clock:
    // an E2E scripts the verdict — and the transport error — without a network.
    { provide: JUDGE_SOURCE, inject: [DB], useFactory: (db: Db) => createDbJudgeSource(db) },
  ],
  exports: [RepairJobsService],
})
export class RepairJobsModule {}
