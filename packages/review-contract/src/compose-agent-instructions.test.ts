import { describe, expect, it } from "vitest";
import { composeAgentInstructions, type AgentInstructionSlot } from "./index";

const slot = (over: Partial<AgentInstructionSlot> = {}): AgentInstructionSlot => ({
  step: 1,
  name: "dashboard",
  instructions: "Open the dashboard.",
  comparePrompt: "The revenue tile shows a number.",
  ...over,
});

const base = {
  testName: "Analytics dashboard",
  environment: "staging",
  baseUrl: "https://staging.acme.io",
  suites: [] as { name: string; instructions: string }[],
  testInstructions: "",
  slots: [slot()],
};

describe("composeAgentInstructions", () => {
  it("orders the three layers general to specific — suite, then test, then the checkpoint's own", () => {
    const text = composeAgentInstructions({
      ...base,
      suites: [{ name: "Checkout", instructions: "SUITE-LAYER" }],
      testInstructions: "TEST-LAYER",
      slots: [slot({ instructions: "CHECKPOINT-LAYER" })],
    });

    const suiteAt = text.indexOf("SUITE-LAYER");
    const testAt = text.indexOf("TEST-LAYER");
    const checkpointAt = text.indexOf("CHECKPOINT-LAYER");
    expect(suiteAt).toBeGreaterThan(-1);
    expect(suiteAt).toBeLessThan(testAt);
    expect(testAt).toBeLessThan(checkpointAt);
  });

  it("concatenates rather than overrides, so a suite and a test that contradict each other both survive", () => {
    const text = composeAgentInstructions({
      ...base,
      suites: [{ name: "Nightly", instructions: "Log in as qa@acme.io." }],
      testInstructions: "Log in as admin@acme.io.",
    });

    expect(text).toContain("Log in as qa@acme.io.");
    expect(text).toContain("Log in as admin@acme.io.");
  });

  it("keeps every suite that contributes, in the order it was given", () => {
    const text = composeAgentInstructions({
      ...base,
      suites: [
        { name: "Checkout", instructions: "FIRST-SUITE" },
        { name: "Nightly", instructions: "SECOND-SUITE" },
      ],
    });

    expect(text).toContain("Checkout");
    expect(text).toContain("Nightly");
    expect(text.indexOf("FIRST-SUITE")).toBeLessThan(text.indexOf("SECOND-SUITE"));
  });

  it("drops a suite whose instructions are blank rather than heading an empty section with its name", () => {
    const text = composeAgentInstructions({
      ...base,
      suites: [
        { name: "Empty", instructions: "   \n  " },
        { name: "Checkout", instructions: "Real context." },
      ],
    });

    expect(text).not.toContain("Empty");
    expect(text).toContain("Checkout");
  });

  it("writes no shared-context section at all when no suite contributes", () => {
    const withNone = composeAgentInstructions({ ...base, testInstructions: "TEST-LAYER" });
    const withBlank = composeAgentInstructions({
      ...base,
      testInstructions: "TEST-LAYER",
      suites: [{ name: "Empty", instructions: "" }],
    });

    expect(withNone).not.toMatch(/shared context/i);
    expect(withBlank).toBe(withNone);
  });

  it("scopes the suite layer as standing context rather than as an instruction that outranks the rest", () => {
    const text = composeAgentInstructions({
      ...base,
      suites: [{ name: "Checkout", instructions: "The app is staging.acme.io." }],
      testInstructions: "TEST-LAYER",
    });

    // The agent reads all three layers as one document, so the suite layer has to say what it is:
    // context that everything after it adds to, NOT a setting the later layers override.
    expect(text).toMatch(/shared context/i);
    expect(text.slice(text.search(/shared context/i), text.indexOf("TEST-LAYER"))).toMatch(
      /replace|override/i,
    );
  });

  it("walks the checkpoints in step order, innermost of the three", () => {
    const text = composeAgentInstructions({
      ...base,
      slots: [
        slot({ step: 1, name: "arrive", instructions: "ONE" }),
        slot({ step: 2, name: "search", instructions: "TWO" }),
        slot({ step: 3, name: "detail", instructions: "THREE" }),
      ],
    });

    expect(text.indexOf("ONE")).toBeLessThan(text.indexOf("TWO"));
    expect(text.indexOf("TWO")).toBeLessThan(text.indexOf("THREE"));
    expect(text).toContain("### 2. search");
  });

  it("names the environment and its base URL, so the agent is not left to guess which app", () => {
    expect(composeAgentInstructions(base)).toContain(
      "Environment: staging (https://staging.acme.io)",
    );
    expect(composeAgentInstructions({ ...base, baseUrl: "" })).toContain("Environment: staging");
  });

  it("says a checkpoint left something unspecified rather than emitting a blank the agent reads past", () => {
    const text = composeAgentInstructions({
      ...base,
      slots: [slot({ instructions: "  ", comparePrompt: "" })],
    });

    expect(text.match(/\(not specified\)/g)).toHaveLength(2);
  });
});
