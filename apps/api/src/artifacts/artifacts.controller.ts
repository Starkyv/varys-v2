import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  StreamableFile,
} from "@nestjs/common";
import type { StorageAdapter } from "@varys/storage-adapter";
import { STORAGE } from "../storage/storage.module";

@Controller("artifacts")
export class ArtifactsController {
  constructor(@Inject(STORAGE) private readonly storage: StorageAdapter) {}

  @Get(":token")
  async get(@Param("token") token: string): Promise<StreamableFile> {
    const key = Buffer.from(token, "base64url").toString("utf8");
    const bytes = await this.storage.get(key);
    if (!bytes) throw new NotFoundException();
    const type = key.endsWith(".png") ? "image/png" : "application/octet-stream";
    return new StreamableFile(bytes, { type });
  }
}
