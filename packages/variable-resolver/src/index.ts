import type { TestDefinition } from "@varys/step-schema";

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

/** Resolve every token in a definition against a profile (transient, worker-only). */
export function resolveDefinition(
  definition: TestDefinition,
  profile: EnvironmentProfile,
): TestDefinition {
  const steps = definition.steps.map((step) =>
    step.type === "navigate"
      ? { ...step, url: resolveString(step.url, profile) }
      : step,
  );
  return { ...definition, steps };
}
