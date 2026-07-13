import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from "@nestjs/common";
import {
  type CreateEnvironmentInput,
  EnvironmentsService,
  type UpdateEnvironmentInput,
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

  @Get()
  list() {
    return this.environments.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.environments.getById(id);
  }

  // Body: { name?, baseUrl?, cookies? (full replace), localStorage? (full replace) }.
  @Put(":id")
  update(@Param("id") id: string, @Body() body: UpdateEnvironmentInput) {
    return this.environments.update(id, body ?? {});
  }

  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.environments.delete(id);
  }
}
