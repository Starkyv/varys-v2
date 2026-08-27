import type { RepairChangeDiff, RepairSignalChange, RepairStepDiff } from "@varys/review-contract";
import { describeStep, type Fingerprint, type Step, type TestDefinition } from "@varys/step-schema";

/**
 * The side-by-side locator diff the repair review surface renders (Slice 19, slice 13).
 *
 * Computed from the two stored DEFINITIONS — the repaired version and the one it was written on
 * top of — never from the agent's account of itself. That is the whole reason the review gate is
 * worth anything: an agent that re-pinned "Apply filter" to "Refresh" describes its own change
 * generously, and here the evidence can contradict it in front of the reviewer.
 *
 * Two decisions worth stating, because they are what make the diff readable in seconds:
 *
 *  - **Unchanged signals are carried, marked unchanged.** The reviewer's question is "is this the
 *    same control, found differently?", and a role and an ancestor chain that did NOT move are
 *    the evidence that it is. A changes-only list would make a re-pin to a different control look
 *    identical to a re-pin to the same one under a new name.
 *  - **A dropped signal is `null`, not an omission.** Losing a `data-testid` is one of the most
 *    consequential things a repair can do, and it has to read as loudly as replacing one.
 *
 * The prose form of the same thing — {@link describeRepairChange} in `repair-diff.ts` — feeds the
 * justification judge (slice 05). Kept separate on purpose: the judge reads text, the reviewer
 * reads a table, and collapsing them would make one of the two worse.
 */
export function diffRepairSignals(
  before: TestDefinition | undefined,
  after: TestDefinition,
): RepairChangeDiff {
  const beforeSteps = before?.steps ?? [];
  const afterSteps = after.steps ?? [];
  const steps: RepairStepDiff[] = [];
  const shared = Math.min(beforeSteps.length, afterSteps.length);

  for (let i = 0; i < shared; i += 1) {
    const a = beforeSteps[i];
    const b = afterSteps[i];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    steps.push({
      stepIndex: i,
      beforeLabel: describeStep(a),
      afterLabel: describeStep(b),
      signals: signalRows(target(a), target(b)),
      nonSignalChange: changedOutsideTarget(a, b),
    });
  }

  return { steps, stepCountBefore: beforeSteps.length, stepCountAfter: afterSteps.length };
}

const target = (step: Step): Fingerprint | undefined =>
  "target" in step ? (step.target as Fingerprint | undefined) : undefined;

/**
 * Every locator signal, in the order a reviewer weighs them: identity first (the durable ones
 * that should have carried the repair), then name and text (what a rename moves), then structure
 * (where the element sits — the strongest evidence of sameness when a name changed).
 *
 * Empty when neither side has an element target: a navigate or a full-page checkpoint has no
 * locator, and rendering eleven "none → none" rows for it would bury the step that does.
 */
function signalRows(a: Fingerprint | undefined, b: Fingerprint | undefined): RepairSignalChange[] {
  if (!a && !b) return [];
  const rows: Array<[string, string | null, string | null]> = [
    ["Element", a && `<${a.tag}>`, b && `<${b.tag}>`],
    ["Role", a?.role, b?.role],
    ["data-testid", a?.testId, b?.testId],
    ["id", attr(a, "id"), attr(b, "id")],
    ["Accessible name", a?.accessibleName, b?.accessibleName],
    ["Visible text", text(a), text(b)],
    ["Ancestors", ancestors(a), ancestors(b)],
    ["Neighbouring text", list(a?.neighborText), list(b?.neighborText)],
    ["Row scope", scope(a), scope(b)],
    ["Stable classes", list(a?.stableClasses), list(b?.stableClasses)],
    ["Raw selector override", a?.selectorOverride, b?.selectorOverride],
  ].map(([label, from, to]) => [label as string, flat(from), flat(to)]);

  return rows.map(([label, from, to]) => ({
    label,
    before: from,
    after: to,
    changed: from !== to,
  }));
}

/** Did the step change in a way that is NOT a locator signal? Compared with the targets removed,
 *  so a url, a checkpoint name or a typed value edited under a locator repair is visible as such
 *  rather than reading as "changed in ways we did not show you". */
function changedOutsideTarget(a: Step, b: Step): boolean {
  const strip = (s: Step) => {
    const { target: _t, ...rest } = s as Step & { target?: unknown };
    return JSON.stringify(rest);
  };
  return strip(a) !== strip(b);
}

const attr = (fp: Fingerprint | undefined, name: string): string | undefined =>
  fp?.attributes?.[name];

/** Visible text is capped for display exactly as the locator panel caps it — a recorded blob of
 *  live figures would otherwise push every other signal off the row. */
const text = (fp: Fingerprint | undefined): string | undefined =>
  fp?.text ? fp.text.slice(0, 400) : undefined;

const ancestors = (fp: Fingerprint | undefined): string | undefined =>
  fp?.ancestors?.length
    ? fp.ancestors
        .map((an) => {
          let s = an.tag;
          if (an.role) s += `[${an.role}]`;
          if (an.id) s += `#${an.id}`;
          else if (an.testId) s += `[data-testid="${an.testId}"]`;
          return s;
        })
        .join(" › ")
    : undefined;

const scope = (fp: Fingerprint | undefined): string | undefined =>
  fp?.scope ? `${fp.scope.container} containing “${fp.scope.text}”` : undefined;

const list = (v: string[] | undefined): string | undefined => (v?.length ? v.join(" · ") : undefined);

/** One display string, or null for "none recorded" — never an empty string, so a reviewer never
 *  sees a blank cell they cannot interpret. */
const flat = (v: string | null | undefined): string | null => (v ? v : null);
