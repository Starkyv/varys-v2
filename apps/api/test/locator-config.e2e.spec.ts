import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authed, prepareAuth } from "./auth-harness";
import { AppModule } from "../src/app.module";
import { startTestDb, type TestDb } from "./db-harness";

/**
 * Slice 16.1 (Locator editor) — editing a step's locator through the config front door,
 * pinned at the HTTP API. The guarantees worth nailing: the read-model surfaces a `target`
 * for steps WITH an element target (click / type / element-screenshot) and null otherwise;
 * editing the signals merges onto the fingerprint and PRESERVES every other captured signal;
 * clearing a signal drops just it; a stale baseVersion is a 409; and clearing a locator down
 * to nothing matchable is a 400. Writing a new version is the observable proof it took.
 */
describe("Locator editor — config", () => {
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

  // A test with: a navigate (no target), a click with a rich multi-signal fingerprint, a
  // full-page screenshot (no target), an element screenshot (target), and a click whose
  // ONLY signal is its accessible name (for the "nothing to match on" guard).
  const mkTest = async (name: string): Promise<string> => {
    const definition = {
      name,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "http://fixture.local/" },
        {
          type: "click",
          target: {
            tag: "button",
            role: "button",
            accessibleName: "Submit",
            text: "Submit",
            stableClasses: ["btn", "btn-primary"],
            ancestors: [{ tag: "form" }],
          },
        },
        { type: "screenshot", name: "page", captureMode: "fullpage" },
        {
          type: "screenshot",
          name: "card",
          captureMode: "element",
          target: { tag: "div", attributes: { id: "card" }, stableClasses: ["card"] },
        },
        { type: "click", target: { tag: "button", accessibleName: "Lonely" } },
      ],
    };
    const res = await authed(app).post("/tests").send(definition).expect(201);
    return res.body.id as string;
  };

  it("surfaces an editable target for element-targeted steps, and null otherwise", async () => {
    const id = await mkTest("read-model");
    const cfg = await authed(app).get(`/tests/${id}/config`).expect(200);
    const steps = cfg.body.steps as { type: string; target: Record<string, unknown> | null }[];

    expect(steps[0].target).toBeNull(); // navigate
    expect(steps[1].target).toMatchObject({
      tag: "button",
      role: "button",
      accessibleName: "Submit",
      text: "Submit",
    });
    expect(steps[2].target).toBeNull(); // full-page screenshot
    expect(steps[3].target).toMatchObject({ tag: "div", elementId: "card" }); // element screenshot
    expect(steps[4].target).toMatchObject({ tag: "button", accessibleName: "Lonely" });

    // The config read-model also drives the verify control's environment requirement
    // (Slice 16.3b): this fixture uses a literal URL + no tokens, so no environment is needed.
    expect(cfg.body.needsEnvironment).toBe(false);
    expect(cfg.body.variables).toEqual([]);
  });

  it("merges edited signals into a new version, preserving the rest; clearing drops just that signal", async () => {
    const id = await mkTest("edit");

    // Edit role-step's name + add a test id; omit role/text (must be preserved).
    const v2 = await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 1, steps: [{ index: 1, target: { accessibleName: "Save", testId: "submit-btn" } }] })
      .expect(200);
    expect(v2.body.version).toBe(2);

    const afterEdit = await authed(app).get(`/tests/${id}`).expect(200);
    const t2 = afterEdit.body.definition.steps[1].target;
    expect(t2).toMatchObject({
      tag: "button",
      role: "button", // omitted from the patch → preserved
      accessibleName: "Save", // edited
      text: "Submit", // omitted → preserved
      testId: "submit-btn", // added
      stableClasses: ["btn", "btn-primary"], // non-editable signal → preserved verbatim
      ancestors: [{ tag: "form" }],
    });

    // Clearing a signal (empty string) drops just it; the others stay.
    const v3 = await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 2, steps: [{ index: 1, target: { text: "" } }] })
      .expect(200);
    expect(v3.body.version).toBe(3);

    const afterClear = await authed(app).get(`/tests/${id}`).expect(200);
    const t3 = afterClear.body.definition.steps[1].target;
    expect(t3.text).toBeUndefined(); // cleared
    expect(t3).toMatchObject({ role: "button", accessibleName: "Save", testId: "submit-btn" });
  });

  it("rejects a stale baseVersion with 409", async () => {
    const id = await mkTest("stale");
    await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 1, steps: [{ index: 1, target: { accessibleName: "First" } }] })
      .expect(200);
    // Now at v2 — a save still based on v1 must be rejected.
    await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 1, steps: [{ index: 1, target: { accessibleName: "Stale" } }] })
      .expect(409);
  });

  it("round-trips an author selectorOverride through a save, and clears it without dropping the rest", async () => {
    const id = await mkTest("override");
    const v2 = await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 1, steps: [{ index: 1, target: { selectorOverride: "#submit-btn" } }] })
      .expect(200);
    expect(v2.body.version).toBe(2);

    const after = await authed(app).get(`/tests/${id}`).expect(200);
    const t = after.body.definition.steps[1].target;
    expect(t.selectorOverride).toBe("#submit-btn");
    expect(t.role).toBe("button"); // override is additive — the signal bundle is intact

    // Clearing the override drops just it.
    await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 2, steps: [{ index: 1, target: { selectorOverride: "" } }] })
      .expect(200);
    const cleared = await authed(app).get(`/tests/${id}`).expect(200);
    expect(cleared.body.definition.steps[1].target.selectorOverride).toBeUndefined();
    expect(cleared.body.definition.steps[1].target.role).toBe("button");
  });

  it("rejects clearing a locator down to nothing matchable with 400", async () => {
    const id = await mkTest("empty");
    // Step 4's only signal is its accessible name — clearing it leaves a tag-only locator.
    await authed(app)
      .put(`/tests/${id}/config`)
      .send({ baseVersion: 1, steps: [{ index: 4, target: { accessibleName: "" } }] })
      .expect(400);
    // The rejected save left the version untouched.
    const got = await authed(app).get(`/tests/${id}`).expect(200);
    expect(got.body.version).toBe(1);
  });
});
