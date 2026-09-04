import { Controller, Delete, Get, Inject, Param, Post } from "@nestjs/common";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { SuiteRunsService } from "./suite-runs.service";

/** Suite-run read side (history + report) plus the two things you do TO a past fan-out:
 *  re-run it and delete it. The first trigger of a suite lives on the suite resource itself
 *  (`POST /suites/:id/runs`) in the suites controller — a re-run is addressed by the report
 *  it repeats, so it belongs here. */
@Controller("suite-runs")
export class SuiteRunsController {
  // Explicit token so DI works without emitted decorator metadata.
  constructor(@Inject(SuiteRunsService) private readonly suiteRuns: SuiteRunsService) {}

  @Get()
  list() {
    return this.suiteRuns.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.suiteRuns.getById(id);
  }

  // Repeat this fan-out: same suite, same environments, membership + versions re-resolved now.
  // 409 when the suite or every targeted environment has since been deleted.
  @Post(":id/rerun")
  rerun(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.suiteRuns.rerun(id, user.email);
  }

  // Delete the fan-out and every child run (irreversible). Baselines are untouched.
  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.suiteRuns.deleteSuiteRun(id);
  }
}
