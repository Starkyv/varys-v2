import type { Fingerprint, Step, TestDefinition, Wait } from "@varys/step-schema";

/**
 * Per-environment values. `secrets` are kept apart from `values` so callers can
 * redact them; both are resolved into steps only transiently inside the worker
 * and are never persisted.
 */
export interface EnvironmentProfile {
  values: Record<string, string>;
  secrets: Record<string, string>;
}

const TOKEN = /\{\{\s*(secret:)?([\w.-]+)\s*\}\}/g;

/** Substitute {{name}} (from values) and {{secret:name}} (from secrets). */
export function resolveString(input: string, profile: EnvironmentProfile): string {
  return input.replace(TOKEN, (_match, isSecret: string | undefined, name: string) => {
    const map = isSecret ? profile.secrets : profile.values;
    if (!(name in map)) {
      throw new Error(`unresolved ${isSecret ? "secret" : "variable"}: ${name}`);
    }
    return map[name];
  });
}

/** Resolve tokens in a fingerprint's visible-text signals (a selector-guard "bind"
 *  puts a `{{variable}}` there). Token-free text is returned unchanged. */
function resolveFingerprint(fp: Fingerprint, profile: EnvironmentProfile): Fingerprint {
  const out = { ...fp };
  if (fp.text !== undefined) out.text = resolveString(fp.text, profile);
  if (fp.accessibleName !== undefined) {
    out.accessibleName = resolveString(fp.accessibleName, profile);
  }
  return out;
}

/** Resolve fingerprint tokens inside selector waits; other wait kinds are untouched.
 *  Exported so the runner can resolve test-level default waits (which aren't attached
 *  to any single step) the same way it resolves a step's own `waitBefore`. */
export function resolveWaits(waits: Wait[], profile: EnvironmentProfile): Wait[] {
  return waits.map((w) =>
    w.kind === "selector" ? { ...w, target: resolveFingerprint(w.target, profile) } : w,
  );
}

/** Resolve every token in a single step against a profile (transient, worker-only).
 *  Covers navigate urls, typed values, and the visible-text signals of step + wait
 *  target fingerprints. Throwing here (an unresolved token) is what lets the runner
 *  attribute the failure to *this* step. */
export function resolveStep(step: Step, profile: EnvironmentProfile): Step {
  switch (step.type) {
    case "navigate":
      return { ...step, url: resolveString(step.url, profile) };
    case "type":
      return {
        ...step,
        value: resolveString(step.value, profile),
        target: resolveFingerprint(step.target, profile),
        ...(step.waitBefore ? { waitBefore: resolveWaits(step.waitBefore, profile) } : {}),
      };
    case "click":
      return {
        ...step,
        target: resolveFingerprint(step.target, profile),
        ...(step.waitBefore ? { waitBefore: resolveWaits(step.waitBefore, profile) } : {}),
      };
    case "screenshot":
      return {
        ...step,
        ...(step.target ? { target: resolveFingerprint(step.target, profile) } : {}),
        ...(step.waitBefore ? { waitBefore: resolveWaits(step.waitBefore, profile) } : {}),
      };
    default:
      return step;
  }
}

/** Resolve every token in a definition against a profile (transient, worker-only). */
export function resolveDefinition(
  definition: TestDefinition,
  profile: EnvironmentProfile,
): TestDefinition {
  return { ...definition, steps: definition.steps.map((step) => resolveStep(step, profile)) };
}
