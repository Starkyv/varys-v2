import { describeStep, type Step, type TestDefinition } from "@varys/step-schema";
import { summarizeFingerprint } from "../fingerprint-summary";

/**
 * What a repair actually changed, in text, for the justification gate (Slice 19, slice 05).
 *
 * The gate's whole question is "is this the same control, found differently, or a different
 * control?" — so it has to be shown the locator signals on BOTH sides, not just the agent's
 * account of them. An agent that re-pins "Apply filter" to "Refresh" describes its own change
 * generously; this renders it from the two definitions instead, so the evidence and the claim can
 * disagree in front of the judge.
 *
 * Deliberately plain prose rather than a JSON dump: the signals that matter (role, accessible
 * name, text, test id, raw override) are the ones a rename would change, and burying them in a
 * full fingerprint would drown them.
 */
export function describeRepairChange(
  before: TestDefinition | undefined,
  after: TestDefinition,
): string {
  const beforeSteps = before?.steps ?? [];
  const afterSteps = after.steps;
  const lines: string[] = [];

  if (beforeSteps.length !== afterSteps.length) {
    lines.push(
      `The repair changed the number of steps: ${beforeSteps.length} before, ${afterSteps.length} after. ` +
        "A locator repair does not add or remove steps.",
    );
  }

  const shared = Math.min(beforeSteps.length, afterSteps.length);
  for (let i = 0; i < shared; i += 1) {
    const a = beforeSteps[i];
    const b = afterSteps[i];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const changes = signalChanges(a, b);
    lines.push(
      `Step ${i} — ${describeStep(a)}${describeStep(a) === describeStep(b) ? "" : ` (now: ${describeStep(b)})`}` +
        (changes.length > 0
          ? `\n${changes.map((c) => `  · ${c}`).join("\n")}`
          : "\n  · changed in ways that are not locator signals"),
    );
  }

  if (lines.length === 0) return "Nothing in the definition changed between these two versions.";
  return lines.join("\n");
}

/** The locator signals, before → after, one line each. `(none)` is shown rather than skipped: a
 *  signal that was DROPPED is as telling as one that was replaced. */
function signalChanges(before: Step, after: Step): string[] {
  const a = summarizeFingerprint("target" in before ? before.target : undefined);
  const b = summarizeFingerprint("target" in after ? after.target : undefined);
  if (!a && !b) return [];
  const out: string[] = [];
  const fields = [
    ["tag", a?.tag, b?.tag],
    ["role", a?.role, b?.role],
    ["accessible name", a?.accessibleName, b?.accessibleName],
    ["visible text", a?.text, b?.text],
    ["data-testid", a?.testId, b?.testId],
    ["element id", a?.elementId, b?.elementId],
    ["raw selector override", a?.selectorOverride, b?.selectorOverride],
  ] as const;
  for (const [label, from, to] of fields) {
    if ((from ?? null) === (to ?? null)) continue;
    out.push(`${label}: ${show(from)} → ${show(to)}`);
  }
  return out;
}

const show = (v: string | null | undefined) => (v ? JSON.stringify(v) : "(none)");
