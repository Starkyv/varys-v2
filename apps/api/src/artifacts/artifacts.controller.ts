import {
  Controller,
  Get,
  Header,
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

  // CORS is deliberately permissive: artifacts are token-addressed link-access
  // already, and the hosted Playwright Trace Viewer (trace.playwright.dev) must
  // be able to fetch a trace zip cross-origin FROM THE USER'S BROWSER — the
  // trace never transits a third-party server.
  @Get(":token")
  @Header("Access-Control-Allow-Origin", "*")
  async get(@Param("token") token: string): Promise<StreamableFile> {
    const key = Buffer.from(token, "base64url").toString("utf8");
    const bytes = await this.storage.get(key);
    if (!bytes) throw new NotFoundException();
    const type = key.endsWith(".png") ? "image/png" : "application/octet-stream";
    return new StreamableFile(bytes, { type });
  }
}
