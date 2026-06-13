import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from "@nestjs/common";
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
  create(@Body() body: { name: string; testIds?: string[] }) {
    return this.suites.create(body ?? { name: "" });
  }

  // Body: { name?, testIds? } — testIds is a FULL member-list replace.
  @Put(":id")
  update(@Param("id") id: string, @Body() body: UpdateSuiteInput) {
    return this.suites.update(id, body ?? {});
  }

  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.suites.delete(id);
  }

  // Trigger `suite × env(s)`: fans out one child run per (member test ×
  // environment). Empty/omitted environmentIds ⇒ env-less "default" children.
  @Post(":id/runs")
  run(@Param("id") id: string, @Body() body: { environmentIds?: string[] }) {
    return this.suiteRuns.trigger(id, body?.environmentIds);
  }
}
