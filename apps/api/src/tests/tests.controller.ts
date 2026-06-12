import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { TestsService } from "./tests.service";

@Controller("tests")
export class TestsController {
  constructor(private readonly tests: TestsService) {}

  @Post()
  create(@Body() body: unknown) {
    return this.tests.create(body);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.tests.getById(id);
  }
}
