import { createHash } from "node:crypto";
import type { Fingerprint } from "@varys/step-schema";

/**
 * Repair policy + failure clustering — the pure half of the repair queue (Slice 19).
 *
 * Network-free and browser-free, in the shape of `@varys/locator-engine`: everything here is a
 * function over recorded data, so the semantics are unit-testable without a database, a run, or
 * a model call. The queue tables, the enqueue point and the drainer live elsewhere; what lives
 * here is *what a policy may say* and *which failures are the same failure*.
 *
 * Clustering behaviour (one job per cluster) and the circuit breaker land in slice 07; slice 01
 * only writes the cluster key onto each job, so there is nothing to backfill later.
 */

/** What a test does when a run fails on a locator it cannot resolve. */
export type RepairPolicy = "manual" | "auto";

/** The whole vocabulary, in escalation order. `manual` is the default everywhere. */
export const REPAIR_POLICIES = ["manual", "auto"] as const satisfies readonly RepairPolicy[];

/** Whether an untrusted value (a request body, a database column) is a repair policy. */
export function isRepairPolicy(value: unknown): value is RepairPolicy {
  return typeof value === "string" && (REPAIR_POLICIES as readonly string[]).includes(value);
}

/**
 * Whether an id is one the locator engine could actually address — the SAME predicate
 * `scoreInPage` applies, kept in step with it deliberately. An id the matcher would never
 * use must not key a cluster either: `tippy-14`-style ids are regenerated per render, so
 * keying on one would scatter a single app change across as many clusters as there were runs.
 */
function isUsableId(id: string): boolean {
  return /^[A-Za-z][\w-]*$/.test(id) && !/^tippy-\d+$/.test(id);
}

/** Collapse runs of whitespace (a reflow can rewrap a label without changing it). */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const MAX_KEY = 200;

/** Cap a key so one enormous recorded label can't produce an unindexable row. */
function cap(key: string): string {
  if (key.length <= MAX_KEY) return key;
  // Keep the prefix legible and make the truncation collision-free.
  return `${key.slice(0, MAX_KEY - 13)}~${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

/**
 * The stable identity of a *broken locator*, derived from the failing fingerprint's STRONG
 * signals only — the same ladder the matcher scores by (testId → id → role+name / scope → name
 * → stableClasses). Two tests that recorded the same element share a key, so "one renamed
 * button broke thirty-eight tests" collapses to one cluster rather than thirty-eight.
 *
 * Deliberately blind to every signal that rotates without the app changing: the bounding box
 * (position and size move with layout), build-hashed `moduleClasses`, `domIndex`, and the
 * recorded `cssPath`. Including any of them would split one app change into many clusters.
 *
 * A fingerprint with no strong signal at all still gets a key — a `weak:` hash over what little
 * it has — because an unclusterable failure must still be enqueueable.
 */
export function deriveClusterKey(target: Fingerprint): string {
  if (target.testId) return cap(`testid:${norm(target.testId)}`);

  const id = target.attributes?.id;
  if (id && isUsableId(id)) return cap(`id:${norm(id)}`);

  const name = target.accessibleName ? norm(target.accessibleName) : "";
  if (target.role && name) return cap(`role+name:${norm(target.role)}|${name}`);
  if (target.scope) {
    return cap(`scope:${norm(target.scope.container)}|${norm(target.scope.text)}`);
  }
  if (name) return cap(`name:${name}`);
  if (target.stableClasses?.length) {
    return cap(`class:${[...target.stableClasses].map(norm).sort().join(".")}`);
  }

  // Nothing identifying survives. Hash the durable remainder so the key is still stable
  // run-to-run, and keep the tag in the clear so a human reading the queue sees something.
  const tag = norm(target.tag);
  const weak = JSON.stringify({
    tag,
    text: target.text ? norm(target.text) : null,
    cssPath: target.cssPath ? norm(target.cssPath) : null,
    neighborText: (target.neighborText ?? []).map(norm),
  });
  return `weak:${tag}:${createHash("sha1").update(weak).digest("hex").slice(0, 12)}`;
}
