import type { EnvironmentView, TestVariable } from "@varys/review-contract";

/** Does the environment supply this variable? Secrets are matched by name (their values
 *  are write-only and never returned); plain values must be a present key. Mirrors exactly
 *  what the worker's resolver reads, so "satisfied" here means the run/verify won't fail
 *  with an "unresolved variable" for that token. */
export function isVariableSatisfied(v: TestVariable, env: EnvironmentView): boolean {
  return v.kind === "secret" ? env.secretNames.includes(v.name) : v.name in env.values;
}
