import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  type CreateEnvironmentInput,
  EnvironmentsService,
} from "./environments.service";

@Controller("environments")
export class EnvironmentsController {
  constructor(private readonly environments: EnvironmentsService) {}

  @Post()
  create(@Body() body: CreateEnvironmentInput) {
    return this.environments.create(body);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.environments.getById(id);
  }
}
