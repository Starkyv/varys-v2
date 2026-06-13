import "reflect-metadata";
import { dirname, join } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Pool } from "pg";
import { AppModule } from "./app.module";
import { DDL } from "./db/schema";

/**
 * Playwright's trace viewer, self-hosted from our OWN origin. The hosted viewer
 * (trace.playwright.dev) can't fetch a localhost artifact — a public site reaching
 * loopback is blocked by the browser (Local Network Access). Serving the same
 * static bundle here makes viewer + trace same-origin, so the in-app "Open
 * timeline" link works in dev (via the Vite proxy) and deployed alike. Interim:
 * the custom timeline UI replaces this later. Version-locked to the runner's
 * Playwright via the shared playwright-core install.
 */
const TRACE_VIEWER_DIR = join(
  dirname(require.resolve("playwright-core/package.json")),
  "lib/vite/traceViewer",
);

async function bootstrap() {
  // Apply schema (walking-skeleton stand-in for migrations).
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(DDL);
  await pool.end();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // A recording's definition is structured JSON (no image bytes), but a long session
  // with many richly-fingerprinted steps can still exceed body-parser's 100 KB default.
  app.useBodyParser("json", { limit: "5mb" });
  // The trace viewer's relative-asset bundle serves cleanly under a path prefix;
  // its service worker registers at `/trace-viewer/` scope (self-consistent).
  app.useStaticAssets(TRACE_VIEWER_DIR, { prefix: "/trace-viewer" });
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
