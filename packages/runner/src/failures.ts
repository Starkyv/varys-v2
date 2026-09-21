import type { Fingerprint } from "@varys/step-schema";

/**
 * A run failed because the matcher could not resolve a recorded fingerprint.
 *
 * Thrown instead of a bare `Error` so the class of a failure is a TYPE rather than a substring
 * match on a message: a pixel regression, a failed judge, a false relation and a crash all stay
 * plain errors and are classified as themselves. What the distinction buys is reporting — a run
 * that says `locator` tells its reader to look at selectors rather than at the app.
 *
 * Carries the fingerprint that missed, so the failure can name the element it could not find.
 */
export class LocatorUnresolvedError extends Error {
  /** The recorded fingerprint the matcher could not resolve. */
  readonly target: Fingerprint;

  constructor(message: string, target: Fingerprint) {
    super(message);
    this.name = "LocatorUnresolvedError";
    this.target = target;
  }
}

/**
 * A `context` checkpoint could not be judged at all — no judge provider is configured, or the
 * checkpoint has no prompt and there is no global default.
 *
 * A distinct type for the same reason `LocatorUnresolvedError` is one: the class of a failure is
 * recorded by the code that knows what threw, never matched out of a message. Without it this
 * lands as a generic `crash`, and a run that says "crashed" when the truth is "you have not
 * configured a judge" sends whoever reads it looking in the wrong place.
 */
export class JudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeUnavailableError";
  }
}

/** The classes `classifyThrownFailure` can reach. A subset of `RunFailureKind`: `locator` is
 *  decided by type before this is consulted, `pixel`/`assertion` are decided by a verdict rather
 *  than by a throw, and `unreached` belongs to Agent-Driven Tests. */
export type ThrownFailureKind = "judge" | "timeout" | "crash";

/**
 * Classify a thrown replay failure for `runs.failure_kind` — plain reporting, read by whoever
 * opens the red run.
 *
 * A `LocatorUnresolvedError` never reaches here: it is its own class and is decided by the caller,
 * so it is never inferred. What is left is telling a step that waited for something which never
 * arrived from one that blew up.
 *
 * Playwright's timeout carries `name === "TimeoutError"`, and `JudgeUnavailableError` says a
 * `context` checkpoint could not be judged at all. Reading each error's own type rather than
 * matching its message is what keeps this from rotting the next time a message is reworded.
 */
export function classifyThrownFailure(err: unknown): ThrownFailureKind {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError") return "timeout";
  // A `context` checkpoint that could not be judged at all. Distinguished because "crashed" would
  // send whoever reads the run looking in the wrong place — the app is fine, the judge is not.
  if (name === "JudgeUnavailableError") return "judge";
  return "crash";
}
