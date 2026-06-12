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

  it("throws on an unresolved token", () => {
    expect(() => resolveString("{{missing}}", profile)).toThrow();
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
});
