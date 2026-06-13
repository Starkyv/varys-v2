import { Controller, Get, Inject, Param } from "@nestjs/common";
import { SuiteRunsService } from "./suite-runs.service";

/** Suite-run read side (history + report). The trigger lives on the suite
 *  resource itself (`POST /suites/:id/runs`) in the suites controller. */
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
}
