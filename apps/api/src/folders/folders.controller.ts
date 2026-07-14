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

  // Body: { name, parentId? } — parentId nests the new folder (null/omitted = root).
  @Post()
  create(@Body() body: { name: string; parentId?: string | null }) {
    return this.folders.create(body ?? { name: "" });
  }

  @Put(":id")
  rename(@Param("id") id: string, @Body() body: { name: string }) {
    return this.folders.rename(id, body ?? { name: "" });
  }

  // Reparent a folder. Body: { parentId } — null moves it to the root.
  @Post(":id/move")
  move(@Param("id") id: string, @Body() body: { parentId: string | null }) {
    return this.folders.move(id, body?.parentId ?? null);
  }

  @Delete(":id")
  delete(@Param("id") id: string) {
    return this.folders.delete(id);
  }
}
