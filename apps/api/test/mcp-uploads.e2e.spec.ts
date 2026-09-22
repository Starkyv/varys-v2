import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { authed, mcpToken, mintUser, prepareAuth, type TestIdentity } from "./auth-harness";
import { startTestDb, type TestDb } from "./db-harness";
import { mcpCallTool, mcpTool, pngFixture, pngSha256 } from "./mcp-harness";

/**
 * Handing Varys a screenshot OUT OF BAND — `POST /mcp/uploads`.
 *
 * The route exists because the two that came before it do not cover everyone. `imagePath` is
 * loopback-only, so a deployed Varys never honours it; that left base64 inside the tool call as
 * the only route, where a few hundred KB of PNG becomes a few hundred KB of the agent's own
 * output. The workaround that invites — crop the capture until the base64 fits — quietly degrades
 * the one artifact a human is going to approve as a baseline, which is the failure this prevents.
 *
 * What is asserted here is what a handle IS, since everything else about it follows: it is
 * single-use, it is owner-scoped, and it is not a way around the format checks. The bytes still
 * go through `decodePng` when the ref is redeemed — the ref chooses the route, never the rules.
 */
describe("/mcp/uploads — a screenshot that never passes through the model", () => {
  let app: INestApplication;
  let db: TestDb;
  let storageDir: string;
  let testId: string;

  /** Upload a PNG as whoever holds `token`, returning the raw response. */
  const upload = (bytes: Buffer, token: string) =>
    request(app.getHttpServer())
      .post("/mcp/uploads")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "image/png")
      .send(bytes);

  beforeAll(async () => {
    db = await startTestDb();
    storageDir = await mkdtemp(join(tmpdir(), "varys-art-uploads-"));
    process.env.DATABASE_URL = db.connectionString;
    process.env.VARYS_STORAGE_DIR = storageDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();

    // A DRAFT, created the way Claude creates one: `add_agent_checkpoint` writes only to Drafts,
    // and a test made through the web route is active from the moment it exists.
    const draft = await mcpTool<{ testId: string }>(app, mcpToken(), "create_agent_test", {
      name: "upload journey",
      instructions: "Open the app and sign in as qa@acme.io / hunter2.",
    });
    testId = draft.testId;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  it("refuses an unauthenticated upload, and one that is not the file itself", async () => {
    await request(app.getHttpServer())
      .post("/mcp/uploads")
      .set("Content-Type", "image/png")
      .send(pngFixture("nobody"))
      .expect(401);

    // JSON is the habit this route exists to break: sending base64 here would reintroduce the
    // very encoding step the upload removes.
    const asJson = await request(app.getHttpServer())
      .post("/mcp/uploads")
      .set("Authorization", `Bearer ${mcpToken()}`)
      .send({ image: pngFixture("json").toString("base64") })
      .expect(400);
    expect(asJson.body.message).toMatch(/raw bytes/i);
  });

  it("mints a handle a checkpoint can be written with, carrying the bytes it was given", async () => {
    const bytes = pngFixture("uploaded-capture");
    const res = await upload(bytes, mcpToken()).expect(201);
    expect(res.body.bytes).toBe(bytes.length);
    expect(res.body.imageRef).toMatch(/^upl_/);

    const result = await mcpCallTool(app, mcpToken(), "add_agent_checkpoint", {
      testId,
      name: "uploaded",
      instructions: "Open the app.",
      comparePrompt: "The shell is rendered.",
      imageRef: res.body.imageRef,
    });
    expect(result.isError).toBeFalsy();
  });

  it("spends a handle exactly once", async () => {
    const { body } = await upload(pngFixture("spend-once"), mcpToken()).expect(201);

    const first = await mcpCallTool(app, mcpToken(), "add_agent_checkpoint", {
      testId,
      name: "spent once",
      instructions: "Go on.",
      comparePrompt: "Still rendered.",
      imageRef: body.imageRef,
    });
    expect(first.isError).toBeFalsy();

    // A replayed handle is not a second capture of the same state — it is the same bytes claimed
    // twice, and a Checkpoint filled from one is a Checkpoint nobody actually reached.
    const again = await mcpCallTool(app, mcpToken(), "add_agent_checkpoint", {
      testId,
      name: "spent twice",
      instructions: "Go on.",
      comparePrompt: "Still rendered.",
      imageRef: body.imageRef,
    });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toMatch(/already used|unknown|expired/i);
  });

  it("keeps one person's upload unclaimable by another", async () => {
    const other: TestIdentity = await mintUser("E2E uploader");
    const { body } = await upload(pngFixture("mine-alone"), other.bearer).expect(201);

    // The handle is real and its owner could spend it — but it is not addressable by anyone else,
    // which is the whole of its access control. A ref is a bearer token for exactly one image.
    const stolen = await mcpCallTool(app, mcpToken(), "add_agent_checkpoint", {
      testId,
      name: "not yours",
      instructions: "Go on.",
      comparePrompt: "Still rendered.",
      imageRef: body.imageRef,
    });
    expect(stolen.isError).toBe(true);
    expect(stolen.content[0].text).toMatch(/not an upload you can claim/i);
  });

  it("is a route to the bytes, not a way around the checks they must pass", async () => {
    // A JPEG uploaded perfectly intact is still refused at redemption: the upload carries bytes,
    // `decodePng` decides whether they are a screenshot, and moving the transport must not move
    // that decision.
    const notPng = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const { body } = await upload(notPng, mcpToken()).expect(201);

    const refused = await mcpCallTool(app, mcpToken(), "add_agent_checkpoint", {
      testId,
      name: "not a png",
      instructions: "Go on.",
      comparePrompt: "Still rendered.",
      imageRef: body.imageRef,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/not a PNG/i);
  });

  it("refuses two sources at once, naming both", async () => {
    const bytes = pngFixture("two-sources");
    const { body } = await upload(bytes, mcpToken()).expect(201);

    const refused = await mcpCallTool(app, mcpToken(), "add_agent_checkpoint", {
      testId,
      name: "ambiguous",
      instructions: "Go on.",
      comparePrompt: "Still rendered.",
      imageRef: body.imageRef,
      image: bytes.toString("base64"),
      sha256: pngSha256(bytes),
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/exactly ONE/i);
    expect(refused.content[0].text).toMatch(/imageRef/);
  });
});
