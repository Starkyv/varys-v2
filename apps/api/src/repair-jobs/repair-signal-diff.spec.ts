import type { TestDefinition } from "@varys/step-schema";
import { describe, expect, it } from "vitest";
import { diffRepairSignals } from "./repair-signal-diff";

/**
 * The side-by-side signal diff a reviewer decides on (Slice 19, slice 13).
 *
 * The property under test throughout is the one the review gate rests on: what MOVED is
 * distinguishable from what stayed. A diff that only listed changes would let a re-pin to a
 * different control read exactly like a re-pin to the same one under a new name.
 */
describe("diffRepairSignals", () => {
  const click = (target: Record<string, unknown>): TestDefinition =>
    ({
      name: "t",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      steps: [{ type: "navigate", url: "http://x" }, { type: "click", target }],
    }) as unknown as TestDefinition;

  const save = {
    tag: "button",
    role: "button",
    accessibleName: "Save changes",
    testId: "save-btn",
    attributes: { id: "save-btn" },
    ancestors: [{ tag: "section", id: "form-panel" }],
  };

  it("reports only the steps that differ, in index order", () => {
    const diff = diffRepairSignals(click(save), click({ ...save, testId: "commit-btn" }));
    expect(diff.steps.map((s) => s.stepIndex)).toEqual([1]);
    expect(diff.stepCountBefore).toBe(2);
    expect(diff.stepCountAfter).toBe(2);
  });

  it("marks the moved signal changed and carries the unchanged ones beside it", () => {
    const diff = diffRepairSignals(
      click(save),
      click({ ...save, testId: "commit-btn", accessibleName: "Commit changes" }),
    );
    const byLabel = new Map(diff.steps[0].signals.map((s) => [s.label, s]));

    expect(byLabel.get("data-testid")).toMatchObject({
      before: "save-btn",
      after: "commit-btn",
      changed: true,
    });
    expect(byLabel.get("Accessible name")).toMatchObject({
      before: "Save changes",
      after: "Commit changes",
      changed: true,
    });
    // The evidence that it is the same control: role and ancestors did not move.
    expect(byLabel.get("Role")).toMatchObject({ before: "button", after: "button", changed: false });
    expect(byLabel.get("Ancestors")).toMatchObject({ changed: false });
    expect(byLabel.get("Ancestors")?.after).toContain("form-panel");
  });

  it("shows a DROPPED signal as none rather than omitting it", () => {
    const { testId, ...noTestId } = save;
    const diff = diffRepairSignals(click(save), click(noTestId));
    const testIdRow = diff.steps[0].signals.find((s) => s.label === "data-testid");
    expect(testIdRow).toMatchObject({ before: "save-btn", after: null, changed: true });
  });

  it("flags a change outside the locator signals — a locator repair should not make one", () => {
    const before = click(save);
    const after = click(save);
    (after.steps[1] as unknown as { value: string }).value = "typed";
    const diff = diffRepairSignals(before, after);
    expect(diff.steps[0].nonSignalChange).toBe(true);
    expect(diff.steps[0].signals.every((s) => !s.changed)).toBe(true);
  });

  it("says so when the step count changed, and still diffs the shared steps", () => {
    const after = click({ ...save, testId: "commit-btn" });
    after.steps.push({ type: "navigate", url: "http://y" } as never);
    const diff = diffRepairSignals(click(save), after);
    expect(diff.stepCountBefore).toBe(2);
    expect(diff.stepCountAfter).toBe(3);
    expect(diff.steps.map((s) => s.stepIndex)).toEqual([1]);
  });

  it("has no signals for a step with no element target on either side", () => {
    const before = click(save);
    const after = click(save);
    (after.steps[0] as unknown as { url: string }).url = "http://elsewhere";
    const diff = diffRepairSignals(before, after);
    expect(diff.steps[0]).toMatchObject({ stepIndex: 0, signals: [], nonSignalChange: true });
  });

  it("labels each side with what the step reads as, so a re-pinned step names both", () => {
    const diff = diffRepairSignals(
      click(save),
      click({ ...save, testId: "commit-btn", accessibleName: "Commit changes" }),
    );
    // `describeStep` names the strongest signal it has, which is what a reviewer scanning the
    // step list recognises the step by — so the two sides read differently after a re-pin.
    expect(diff.steps[0].beforeLabel).toContain("save-btn");
    expect(diff.steps[0].afterLabel).toContain("commit-btn");
  });

  it("reports an empty diff for two identical definitions rather than inventing a change", () => {
    expect(diffRepairSignals(click(save), click(save)).steps).toEqual([]);
  });

  it("treats a missing previous definition as everything being new", () => {
    const diff = diffRepairSignals(undefined, click(save));
    expect(diff.stepCountBefore).toBe(0);
    expect(diff.steps).toEqual([]);
  });
});
