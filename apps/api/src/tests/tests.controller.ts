import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { TestsService } from "./tests.service";

@Controller("tests")
export class TestsController {
  // Explicit token so DI works without emitted decorator metadata.
  constructor(@Inject(TestsService) private readonly tests: TestsService) {}

  @Post()
  create(@Body() body: unknown) {
    return this.tests.create(body);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.tests.getById(id);
  }
}
