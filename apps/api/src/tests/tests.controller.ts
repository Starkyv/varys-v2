import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put } from "@nestjs/common";
import type { TestConfigPatch } from "@varys/review-contract";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { TestsService, type UpdateTestInput } from "./tests.service";

@Controller("tests")
export class TestsController {
  // Explicit token so DI works without emitted decorator metadata.
  constructor(@Inject(TestsService) private readonly tests: TestsService) {}

  @Post()
  create(@Body() body: unknown) {
    return this.tests.create(body);
  }

  @Get()
  list() {
    return this.tests.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.tests.getById(id);
  }

  // The editable config surface (waits + threshold) of the test's latest version.
  @Get(":id/config")
  getConfig(@Param("id") id: string) {
    return this.tests.getConfig(id);
  }

  // Apply a config patch → write a new audited test_version. 409 on a stale baseVersion.
  @Put(":id/config")
  saveConfig(@Param("id") id: string, @Body() body: TestConfigPatch, @CurrentUser() user: AuthUser) {
    return this.tests.saveConfig(id, body, user.email);
  }

  // Organization metadata only ({ name?, folderId? — null unfiles }); never the
  // definition, never a new test_version.
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateTestInput) {
    return this.tests.update(id, body ?? {});
  }

  // Hard-delete: removes the test and ALL its runs, baselines, and history. No rollback.
  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.tests.delete(id);
  }
}
