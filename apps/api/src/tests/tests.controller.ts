import { Body, Controller, Get, Inject, Param, Patch, Post } from "@nestjs/common";
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

  // Organization metadata only ({ name?, folderId? — null unfiles }); never the
  // definition, never a new test_version.
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateTestInput) {
    return this.tests.update(id, body ?? {});
  }
}
