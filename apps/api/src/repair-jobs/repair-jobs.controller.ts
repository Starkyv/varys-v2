import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { RepairJobsService } from "./repair-jobs.service";

@Controller("repair-jobs")
export class RepairJobsController {
  // Explicit token so DI works without emitted decorator metadata.
  constructor(@Inject(RepairJobsService) private readonly jobs: RepairJobsService) {}

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
