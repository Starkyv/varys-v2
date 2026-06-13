import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from "@nestjs/common";
import { SuitesService, type UpdateSuiteInput } from "./suites.service";

@Controller("suites")
export class SuitesController {
  // Explicit token so DI works without emitted decorator metadata.
  constructor(@Inject(SuitesService) private readonly suites: SuitesService) {}

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
}
