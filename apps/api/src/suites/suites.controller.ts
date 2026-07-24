import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from "@nestjs/common";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { SuiteRunsService } from "../suite-runs/suite-runs.service";
import { SuitesService, type UpdateSuiteInput } from "./suites.service";

@Controller("suites")
export class SuitesController {
  // Explicit tokens so DI works without emitted decorator metadata.
  constructor(
    @Inject(SuitesService) private readonly suites: SuitesService,
    @Inject(SuiteRunsService) private readonly suiteRuns: SuiteRunsService,
  ) {}

  @Get()
  list() {
    return this.suites.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.suites.getById(id);
  }

  @Post()
  create(
    @Body() body: { name: string; testIds?: string[]; folderIds?: string[] },
    @CurrentUser() user: AuthUser,
  ) {
    return this.suites.create(body ?? { name: "" }, user.email);
  }

  // Body: { name?, testIds?, folderIds?, schedule? } — testIds/folderIds each FULL-replace their
  // selection; schedule sets/clears the suite cron (null clears).
  @Put(":id")
  update(@Param("id") id: string, @Body() body: UpdateSuiteInput, @CurrentUser() user: AuthUser) {
    return this.suites.update(id, body ?? {}, user.email);
  }

  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.suites.delete(id);
  }

  // Trigger `suite × env(s)`: fans out one child run per (member test ×
  // environment). Empty/omitted environmentIds ⇒ env-less "default" children.
  // `trace` (per-trigger on demand) applies to every child.
  @Post(":id/runs")
  run(
    @Param("id") id: string,
    @Body() body: { environmentIds?: string[]; trace?: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    return this.suiteRuns.trigger(id, body?.environmentIds, body?.trace, user.email);
  }
}
