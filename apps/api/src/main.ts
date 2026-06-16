import "reflect-metadata";
import { dirname, join } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { toNodeHandler } from "better-auth/node";
import { Pool } from "pg";
import { AppModule } from "./app.module";
import { getAuth } from "./auth/auth";
import { DDL } from "./db/schema";

/**
 * Origins allowed to make CREDENTIALED cross-origin requests (the recorder extension
 * posting recordings; the web app is same-origin and doesn't need this). Any Chrome
 * extension origin is allowed, plus the configured web origins — never `*`, which is
 * incompatible with credentials. NOTE: CORS only permits the request; whether the
 * session cookie actually rides along cross-origin is a separate SameSite/host concern
 * (see the extension notes / Issue 2).
 */
const TRUSTED_WEB_ORIGINS = (
  process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "http://localhost:5200,http://localhost:4000"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

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

  // bodyParser disabled at create time: the better-auth handler must read the RAW
  // request stream, so it has to be mounted BEFORE any JSON body parser (a parser
  // consumes the stream). We re-add JSON parsing for the rest of the API below.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  // Credentialed CORS for non-browser clients (the extension). Same-origin web traffic
  // is unaffected. Reflect any chrome-extension:// origin + the configured web origins;
  // never `*` with credentials.
  app.enableCors({
    credentials: true,
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl / server-to-server
      if (origin.startsWith("chrome-extension://")) return cb(null, true);
      cb(null, TRUSTED_WEB_ORIGINS.includes(origin));
    },
  });

  // Mount better-auth FIRST, at /api/auth/* (Express 5 named-wildcard syntax), before
  // body parsing. This is Varys's own user-auth front door; see ./auth/auth.ts.
  app.getHttpAdapter().getInstance().all("/api/auth/*splat", toNodeHandler(getAuth()));

  // A recording's definition is structured JSON (no image bytes), but a long session
  // with many richly-fingerprinted steps can still exceed body-parser's 100 KB default.
  app.useBodyParser("json", { limit: "5mb" });
  // The trace viewer's relative-asset bundle serves cleanly under a path prefix;
  // its service worker registers at `/trace-viewer/` scope (self-consistent).
  app.useStaticAssets(TRACE_VIEWER_DIR, { prefix: "/trace-viewer" });
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
