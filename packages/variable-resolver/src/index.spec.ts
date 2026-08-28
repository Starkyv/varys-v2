import type { TestDefinition } from "@varys/step-schema";
import { describe, expect, it } from "vitest";
import { type EnvironmentProfile, resolveDefinition, resolveString } from "./index";

const profile: EnvironmentProfile = { baseUrl: "https://demo.example.com" };

describe("resolveString", () => {
  it("substitutes the {{baseUrl}} token", () => {
    expect(resolveString("{{baseUrl}}/login", profile)).toBe(
      "https://demo.example.com/login",
    );
  });

  it("leaves any other {{token}} literal (no variables/secrets anymore)", () => {
    expect(resolveString("{{username}} and {{secret:password}}", profile)).toBe(
      "{{username}} and {{secret:password}}",
    );
  });

  it("leaves token-free text unchanged", () => {
    expect(resolveString("just literal text", profile)).toBe("just literal text");
  });
});

describe("resolveDefinition", () => {
  it("resolves tokens in navigate urls", () => {
    const def = {
      name: "t",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "{{baseUrl}}/dashboard" },
        { type: "screenshot", name: "h", target: { tag: "div" } },
      ],
    } as unknown as TestDefinition;

    const resolved = resolveDefinition(def, profile);
    expect(resolved.steps[0]).toMatchObject({
      type: "navigate",
      url: "https://demo.example.com/dashboard",
    });
  });

  it("resolves a tokenized selector wait on a navigate step", () => {
    const def = {
      name: "t",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "{{baseUrl}}/" },
        {
          type: "navigate",
          url: "{{baseUrl}}/explorer",
          waitBefore: [
            { kind: "delay", ms: 500 },
            { kind: "selector", state: "hidden", target: { tag: "div", text: "{{baseUrl}}" } },
          ],
        },
      ],
    } as unknown as TestDefinition;

    const nav = resolveDefinition(def, profile).steps[1] as {
      url: string;
      waitBefore: Array<{ kind: string; target?: { text: string } }>;
    };
    expect(nav.url).toBe("https://demo.example.com/explorer");
    expect(nav.waitBefore[0]).toEqual({ kind: "delay", ms: 500 });
    expect(nav.waitBefore[1]?.target?.text).toBe("https://demo.example.com");
  });

  it("leaves fingerprint text literal (no data variables anymore)", () => {
    const def = {
      name: "t",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "{{baseUrl}}/" },
        { type: "screenshot", name: "hero", target: { tag: "h1", text: "{{username}}" } },
      ],
    } as unknown as TestDefinition;

    const resolved = resolveDefinition(def, profile);
    const shot = resolved.steps[1] as { target: { text: string } };
    expect(shot.target.text).toBe("{{username}}");
  });

  it("leaves token-free fingerprint text unchanged", () => {
    const def = {
      name: "t",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "{{baseUrl}}/" },
        { type: "screenshot", name: "hero", target: { tag: "div", text: "Hero" } },
      ],
    } as unknown as TestDefinition;

    const resolved = resolveDefinition(def, profile);
    const shot = resolved.steps[1] as { target: { text: string } };
    expect(shot.target.text).toBe("Hero");
  });
});
