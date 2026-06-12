import type { TestDefinition } from "@varys/step-schema";
import { describe, expect, it } from "vitest";
import { type EnvironmentProfile, resolveDefinition, resolveString } from "./index";

const profile: EnvironmentProfile = {
  values: { baseUrl: "https://demo.example.com", username: "alice" },
  secrets: { password: "s3cr3t" },
};

describe("resolveString", () => {
  it("substitutes a value variable", () => {
    expect(resolveString("{{baseUrl}}/login", profile)).toBe(
      "https://demo.example.com/login",
    );
  });

  it("substitutes a secret reference", () => {
    expect(resolveString("{{secret:password}}", profile)).toBe("s3cr3t");
  });

  it("throws a legible error naming an unresolved value variable", () => {
    expect(() => resolveString("{{missing}}", profile)).toThrow("unresolved variable: missing");
  });

  it("throws a legible error naming an unresolved secret", () => {
    expect(() => resolveString("{{secret:missing}}", profile)).toThrow(
      "unresolved secret: missing",
    );
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

  it("resolves a {{variable}} bound into a target fingerprint's visible text", () => {
    const def = {
      name: "t",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [
        { type: "navigate", url: "{{baseUrl}}/" },
        // A selector-guard "bind" puts the token in the fingerprint's text.
        { type: "screenshot", name: "hero", target: { tag: "h1", text: "{{username}}" } },
      ],
    } as unknown as TestDefinition;

    const resolved = resolveDefinition(def, profile);
    const shot = resolved.steps[1] as { target: { text: string } };
    expect(shot.target.text).toBe("alice");
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
