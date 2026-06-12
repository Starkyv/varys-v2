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

  @Post(":id/checkpoints/:name/approve")
  approve(@Param("id") id: string, @Param("name") name: string) {
    return this.runs.approve(id, name);
  }

  @Post(":id/checkpoints/:name/reject")
  reject(@Param("id") id: string, @Param("name") name: string) {
    return this.runs.reject(id, name);
  }
}
