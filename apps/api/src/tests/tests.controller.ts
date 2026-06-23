import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from "@nestjs/common";
import type { LocatorVerifyRequest, TestConfigPatch } from "@varys/review-contract";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { LocatorVerifyService } from "./locator-verify.service";
import { TestsService, type UpdateTestInput } from "./tests.service";

@Controller("tests")
export class TestsController {
  // Explicit tokens so DI works without emitted decorator metadata.
  constructor(
    @Inject(TestsService) private readonly tests: TestsService,
    @Inject(LocatorVerifyService) private readonly locatorVerify: LocatorVerifyService,
  ) {}

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.tests.create(body, user.email);
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

  // Live-verify a candidate (unsaved) locator at one step against a chosen environment, via
  // a transient partial replay. Persists nothing; 409 if superseded by a newer verify.
  @Post(":id/config/verify")
  @HttpCode(200) // a probe — resolves nothing, persists nothing
  verifyLocator(@Param("id") id: string, @Body() body: LocatorVerifyRequest) {
    return this.locatorVerify.verify(id, body);
  }

  // Relational metadata only ({ name?, folderId? — null unfiles, tags?, schedule? });
  // never the definition, never a new test_version. The actor owns any cron schedule set.
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateTestInput, @CurrentUser() user: AuthUser) {
    return this.tests.update(id, body ?? {}, user.email);
  }

  // Hard-delete: removes the test and ALL its runs, baselines, and history. No rollback.
  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.tests.delete(id);
  }
}
