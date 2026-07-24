import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authed, prepareAuth } from "./auth-harness";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Phase 6 (authoring backend the web editor drives): switching a checkpoint's comparison from
 * pixel to `context` + a judge prompt through the config front door, pinned at the HTTP API.
 * Guarantees: the read-model surfaces `compareMode`/`prompt`; a pixel→context edit with a prompt
 * writes a new version and round-trips; switching to context WITHOUT a prompt is a 400.
 */
describe("Compare mode — config authoring", () => {
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

  const mkTest = async (name: string): Promise<string> => {
    const definition = {
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "http://fixture.local/" },
        { type: "screenshot", name: "brief", captureMode: "fullpage" },
      ],
    };
    const res = await authed(app).post("/tests").send(definition).expect(201);
    return res.body.id as string;
  };

  it("defaults a screenshot step to pixel in the read-model", async () => {
    const id = await mkTest("cm default");
    const cfg = await authed(app).get(`/tests/${id}/config`).expect(200);
    const shot = (cfg.body.steps as { type: string; compareMode: string | null; prompt: string | null }[]).find(
      (s) => s.type === "screenshot",
    );
    expect(shot).toMatchObject({ compareMode: "pixel", prompt: null });
  });

  it("switches a checkpoint to context + prompt and round-trips it", async () => {
    const id = await mkTest("cm switch");
    const prompt = "both are AI-generated briefs; ignore that words/numbers differ; is the current one broken?";

    await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 1, steps: [{ index: 1, compareMode: "context", prompt }] })
      .expect(200);

    const cfg = await authed(app).get(`/tests/${id}/config`).expect(200);
    expect(cfg.body.version).toBe(2); // a new audited version was written
    const shot = (cfg.body.steps as { type: string; compareMode: string; prompt: string }[]).find(
      (s) => s.type === "screenshot",
    );
    expect(shot).toMatchObject({ compareMode: "context", prompt });
  });

  it("allows switching to context WITHOUT a prompt (inherits the global default)", async () => {
    const id = await mkTest("cm no prompt");
    await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 1, steps: [{ index: 1, compareMode: "context" }] })
      .expect(200);

    const cfg = await authed(app).get(`/tests/${id}/config`).expect(200);
    const shot = (cfg.body.steps as { type: string; compareMode: string; prompt: string | null }[]).find(
      (s) => s.type === "screenshot",
    );
    expect(shot).toMatchObject({ compareMode: "context", prompt: null });
  });

  it("accepts a BLANK prompt string (the editor sends '') without erroring — normalised to inherit", async () => {
    const id = await mkTest("cm blank prompt");
    // Reproduces the editor leaving the prompt box empty: it sends prompt:"" (not an absent field),
    // which previously failed the save (empty string violates the schema's min(1)).
    await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 1, steps: [{ index: 1, compareMode: "context", prompt: "   " }] })
      .expect(200);

    const cfg = await authed(app).get(`/tests/${id}/config`).expect(200);
    const shot = (cfg.body.steps as { type: string; compareMode: string; prompt: string | null }[]).find(
      (s) => s.type === "screenshot",
    );
    expect(shot).toMatchObject({ compareMode: "context", prompt: null }); // blank ⇒ omitted
  });

  it("can switch context back to pixel", async () => {
    const id = await mkTest("cm revert");
    await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 1, steps: [{ index: 1, compareMode: "context", prompt: "still good?" }] })
      .expect(200);
    await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 2, steps: [{ index: 1, compareMode: "pixel" }] })
      .expect(200);

    const cfg = await authed(app).get(`/tests/${id}/config`).expect(200);
    const shot = (cfg.body.steps as { type: string; compareMode: string }[]).find((s) => s.type === "screenshot");
    expect(shot?.compareMode).toBe("pixel");
  });
});
