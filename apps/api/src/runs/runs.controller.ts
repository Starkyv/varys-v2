import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { RunsService } from "./runs.service";

@Controller("runs")
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Post()
  create(@Body() body: { testId: string }) {
    return this.runs.create(body.testId);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.runs.getById(id);
  }
}
