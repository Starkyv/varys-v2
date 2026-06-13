import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from "@nestjs/common";
import { FoldersService } from "./folders.service";

@Controller("folders")
export class FoldersController {
  // Explicit token so DI works without emitted decorator metadata.
  constructor(@Inject(FoldersService) private readonly folders: FoldersService) {}

  @Get()
  list() {
    return this.folders.list();
  }

  @Post()
  create(@Body() body: { name: string }) {
    return this.folders.create(body ?? { name: "" });
  }

  @Put(":id")
  rename(@Param("id") id: string, @Body() body: { name: string }) {
    return this.folders.rename(id, body ?? { name: "" });
  }

  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.folders.delete(id);
  }
}
