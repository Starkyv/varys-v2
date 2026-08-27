import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { RepairJobsService } from "./repair-jobs.service";
import { RepairReviewsService } from "./repair-reviews.service";

@Controller("repair-jobs")
export class RepairJobsController {
  // Explicit token so DI works without emitted decorator metadata.
  constructor(
    @Inject(RepairJobsService) private readonly jobs: RepairJobsService,
    @Inject(RepairReviewsService) private readonly reviews: RepairReviewsService,
  ) {}

  // The repair REVIEW queue: repaired versions awaiting a human accept/reject (slice 04). Nested
  // under `/repair-jobs` deliberately — a new top-level prefix would also need adding to the web
  // app's dev proxy allowlist, and this is the same feature's surface either way.
  //
  // Declared ABOVE the `:id` routes so "reviews" is never read as a job id.
  @Get("reviews")
  listReviews() {
    return this.reviews.list();
  }

  /** Accept a repaired version: it is reviewed, and it stays the test's active definition.
   *  Web-only, like draft promotion — an agent must not be able to approve its own work. */
  @Post("reviews/:versionId/accept")
  @HttpCode(200) // records a decision on an existing version; creates nothing
  accept(@Param("versionId") versionId: string, @CurrentUser() user: AuthUser) {
    return this.reviews.accept(versionId, user.email);
  }

  /** Reject a repaired version: the test reverts to its previous definition and the job ends. */
  @Post("reviews/:versionId/reject")
  @HttpCode(200)
  reject(@Param("versionId") versionId: string, @CurrentUser() user: AuthUser) {
    return this.reviews.reject(versionId, user.email);
  }

  // The repair queue. Open jobs (queued + claimed) by default; `?all=1` includes finished,
  // failed and cancelled ones.
  @Get()
  list(@Query("all") all?: string) {
    return this.jobs.list({ all: all === "1" || all === "true" });
  }

  // Enqueue a repair by hand from a failed run — for a test whose policy is `manual`.
  @Post()
  enqueue(@Body() body: { runId: string }) {
    return this.jobs.enqueueForRun(body?.runId ?? "");
  }

  // Cancel a queued (unclaimed) job. A claimed job is released by its drainer, not cancelled.
  @Post(":id/cancel")
  @HttpCode(200) // mutates an existing job; creates nothing
  cancel(@Param("id") id: string) {
    return this.jobs.cancel(id);
  }
}
