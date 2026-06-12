import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import {
  type CreateEnvironmentInput,
  EnvironmentsService,
} from "./environments.service";

@Controller("environments")
export class EnvironmentsController {
  // Explicit token so DI works without emitted decorator metadata.
  constructor(
    @Inject(EnvironmentsService) private readonly environments: EnvironmentsService,
  ) {}

  @Post()
  create(@Body() body: CreateEnvironmentInput) {
    return this.environments.create(body);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.environments.getById(id);
  }
}
