import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import type { TuningInput } from "@varys/review-contract";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { RunsService } from "./runs.service";

@Controller("runs")
export class RunsController {
  // Explicit token so DI works without emitted decorator metadata (the dev
  // runner, tsx/esbuild, doesn't emit design:paramtypes).
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  // `trace` asks for a Playwright trace to be kept (per-trigger on demand only).
  @Post()
  create(@Body() body: { testId: string; environmentId?: string; trace?: boolean }) {
    return this.runs.create(body.testId, {
      environmentId: body.environmentId,
      trace: body.trace,
    });
  }

  // The Runs history — every run, newest first (all outcomes).
  @Get()
  list() {
    return this.runs.listRuns();
  }

  // Declared before the `:id` param route so it isn't matched as a run id.
  @Get("needs-review")
  needsReview() {
    return this.runs.needsReview();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.runs.getById(id);
  }

  @Post(":id/approve-all")
  approveAll(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.runs.approveAll(id, user.email);
  }

  @Post(":id/checkpoints/:name/approve")
  approve(@Param("id") id: string, @Param("name") name: string, @CurrentUser() user: AuthUser) {
    return this.runs.approve(id, name, user.email);
  }

  @Post(":id/checkpoints/:name/reject")
  reject(@Param("id") id: string, @Param("name") name: string) {
    return this.runs.reject(id, name);
  }

  // Preview: re-diff the stored baseline+actual with candidate masks/threshold.
  // No mutation, no re-run.
  @Post(":id/checkpoints/:name/re-evaluate")
  reEvaluate(
    @Param("id") id: string,
    @Param("name") name: string,
    @Body() body: TuningInput,
  ) {
    return this.runs.reEvaluate(id, name, body ?? {});
  }

  // Commit: write a new test_version with the masks/threshold and re-judge this
  // checkpoint's run_result.
  @Post(":id/checkpoints/:name/persist")
  persist(
    @Param("id") id: string,
    @Param("name") name: string,
    @Body() body: TuningInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.runs.persistMasks(id, name, body ?? {}, user.email);
  }
}
