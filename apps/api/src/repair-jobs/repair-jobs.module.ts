import { Module } from "@nestjs/common";
import { CLOCK, SYSTEM_CLOCK } from "./clock";
import { RepairJobsController } from "./repair-jobs.controller";
import { RepairJobsService } from "./repair-jobs.service";
import { RepairReviewsService } from "./repair-reviews.service";

@Module({
  controllers: [RepairJobsController],
  // The clock is a provider so an E2E can override it and step over a lease expiry without
  // sleeping (slice 03) — see `./clock`.
  providers: [RepairJobsService, RepairReviewsService, { provide: CLOCK, useValue: SYSTEM_CLOCK }],
  exports: [RepairJobsService],
})
export class RepairJobsModule {}
