import "reflect-metadata";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, type DbHandle } from "@varys/db";
import { type FixtureServer, startFixtureServer } from "@varys/fixture-app";
import { type Boss, createBoss, startBoss, workRuns } from "@varys/queue";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";
import { type Browser, chromium } from "playwright";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ["passed", "needs_review", "failed"];

const REPO_ROOT = resolve(__dirname, "../../..");
const WEB_DIST = resolve(__dirname, "../../web/dist");
const API_PREFIXES = ["/runs", "/tests", "/environments", "/artifacts"];
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function isApiPath(url: string): boolean {
  return API_PREFIXES.some(
    (p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`),
  );
}

/**
 * Browser E2E (visual-review-ui Issue 1 TB3): Playwright drives the real built
 * SPA against the real API + worker + Postgres (testcontainers) + local-FS, all
 * behind one same-origin server (API routes → the in-process Express app, everything
 * else → the built apps/web bundle, with SPA fallback). Seeds a diffed run and
 * asserts the baseline / actual / diff images actually render.
 */
describe("Visual review UI (browser E2E)", () => {
  let app: INestApplication;
  let db: TestDb;
  let fixture: FixtureServer;
  let storageDir: string;
  let consumerBoss: Boss;
  let consumerDb: DbHandle;
  let server: Server;
  let browser: Browser;
  let webBase: string;

  beforeAll(async () => {
    // Build the SPA same-origin (relative API base) so it talks to the combined server.
    execSync("pnpm --filter @varys/web exec vite build", {
      cwd: REPO_ROOT,
      env: { ...process.env, VITE_API_BASE: "" },
      stdio: "pipe",
    });

    fixture = await startFixtureServer();
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    consumerDb = createDb(db.connectionString);
    consumerBoss = createBoss(db.connectionString);
    await startBoss(consumerBoss);
    const storage = new LocalFsAdapter(storageDir);
    await workRuns(consumerBoss, (runId) =>
      processRun({ db: consumerDb.db, storage }, runId),
    );

    // One same-origin server: API routes hit the in-process Express app; everything
    // else is served from the built SPA, falling back to index.html (client routing).
    const expressApp = app.getHttpAdapter().getInstance() as (req: unknown, res: unknown) => void;
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (isApiPath(url)) {
        expressApp(req, res);
        return;
      }
      const path = url.split("?")[0];
      const candidate = join(WEB_DIST, path === "/" ? "index.html" : path.replace(/^\//, ""));
      const file = existsSync(candidate) ? candidate : join(WEB_DIST, "index.html");
      readFile(file)
        .then((buf) => {
          const ext = file.slice(file.lastIndexOf("."));
          res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
          res.end(buf);
        })
        .catch(() => {
          res.statusCode = 500;
          res.end("static error");
        });
    });
    await new Promise<void>((r) => server.listen(0, r));
    webBase = `http://localhost:${(server.address() as AddressInfo).port}`;

    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server?.close(() => r()));
    await consumerBoss?.stop();
    await consumerDb?.pool.end();
    await app?.close();
    await db?.container.stop();
    await fixture?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  async function runToCompletion(testId: string): Promise<{ runId: string; status: string }> {
    const run = await request(app.getHttpServer())
      .post("/runs")
      .send({ testId })
      .expect(201);
    const runId = run.body.runId as string;
    let status = "queued";
    for (let i = 0; i < 100; i++) {
      const res = await request(app.getHttpServer()).get(`/runs/${runId}`).expect(200);
      status = res.body.status;
      if (TERMINAL.includes(status)) break;
      await sleep(200);
    }
    return { runId, status };
  }

  async function createTest(): Promise<string> {
    const definition = {
      name: "review ui test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: fixture.url },
        { type: "screenshot", name: "hero", target: { tag: "div", attributes: { id: "hero" }, text: "Hero" } },
      ],
    };
    const res = await request(app.getHttpServer()).post("/tests").send(definition).expect(201);
    return res.body.id as string;
  }

  it("renders baseline, actual, and diff for a diffed run", async () => {
    // Seed a baseline, then produce a diff against it.
    fixture.setVariant("default");
    const testId = await createTest();
    const seed = await runToCompletion(testId);
    await request(app.getHttpServer())
      .post(`/runs/${seed.runId}/checkpoints/hero/approve`)
      .expect(201);

    fixture.setVariant("changed");
    const diffRun = await runToCompletion(testId);
    fixture.setVariant("default");
    expect(diffRun.status).toBe("needs_review");

    // Drive the real SPA at the deep link and assert the three images rendered.
    // Same-origin deep link: ?run=<id> (the /runs/:id path is the API's, served by
    // the combined server's Express branch — the SPA uses the query form here).
    const page = await browser.newPage();
    await page.goto(`${webBase}/?run=${diffRun.runId}`);

    for (const name of ["baseline", "actual", "diff highlight"]) {
      const img = page.getByRole("img", { name });
      await img.waitFor({ state: "visible", timeout: 10_000 });
      const naturalWidth = await img.evaluate(
        (el) => (el as unknown as { naturalWidth: number }).naturalWidth,
      );
      expect(naturalWidth, `${name} image should have loaded`).toBeGreaterThan(0);
    }

    await page.close();
  }, 120_000);
});
