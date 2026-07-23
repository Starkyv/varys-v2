import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authed, prepareAuth } from "./auth-harness";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Config-C — the judge (context-compare) settings on the Configurations page, pinned at the HTTP
 * API. The guarantees that matter: the read is MASKED (the API key is never returned, only a
 * set-flag + last-4 hint); a save round-trips provider/model; and a masked re-save (no apiKey)
 * keeps the stored key rather than wiping it.
 */
describe("Judge settings — masked config", () => {
  let app: INestApplication;
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.connectionString;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prepareAuth();
  });

  afterAll(async () => {
    await app?.close();
    await db?.container.stop();
  });

  it("defaults to gemini with no key and an empty default prompt", async () => {
    const res = await authed(app).get("/settings/judge").expect(200);
    expect(res.body).toMatchObject({ provider: "gemini", apiKeySet: false, apiKeyHint: null, defaultPrompt: "" });
  });

  it("stores and round-trips the default judge prompt", async () => {
    const prompt = "Ignore wording/number changes; fail only if the current one is broken.";
    await authed(app).put("/settings/judge").send({ defaultPrompt: prompt }).expect(200);
    const res = await authed(app).get("/settings/judge").expect(200);
    expect(res.body.defaultPrompt).toBe(prompt);
  });

  it("saves provider/model + key and returns a MASKED view (key never echoed)", async () => {
    const save = await authed(app)
      .put("/settings/judge")
      .send({ provider: "gemini", model: "gemini-2.0-flash", apiKey: "AIzaSecretKey1234" })
      .expect(200);

    expect(save.body).toMatchObject({
      provider: "gemini",
      model: "gemini-2.0-flash",
      apiKeySet: true,
      apiKeyHint: "1234", // last 4 only
    });
    // The raw key must never appear anywhere in the response.
    expect(JSON.stringify(save.body)).not.toContain("AIzaSecretKey1234");

    const get = await authed(app).get("/settings/judge").expect(200);
    expect(get.body.apiKeySet).toBe(true);
    expect(JSON.stringify(get.body)).not.toContain("AIzaSecretKey1234");
  });

  it("a masked re-save (no apiKey) keeps the stored key", async () => {
    await authed(app)
      .put("/settings/judge")
      .send({ provider: "gemini", model: "gemini-2.0-flash", apiKey: "AIzaKeepMe9999" })
      .expect(200);

    // Re-save changing only the model, with NO apiKey field (as the masked form would).
    const res = await authed(app)
      .put("/settings/judge")
      .send({ provider: "gemini", model: "gemini-2.5-flash" })
      .expect(200);

    expect(res.body).toMatchObject({ model: "gemini-2.5-flash", apiKeySet: true, apiKeyHint: "9999" });
  });

  it("can switch provider to anthropic", async () => {
    const res = await authed(app)
      .put("/settings/judge")
      .send({ provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-ant-abcd" })
      .expect(200);
    expect(res.body).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", apiKeyHint: "abcd" });
  });
});
