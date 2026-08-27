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
 * Three things, in the order the queue uses them (slice 07): cluster-key derivation from a
 * failing locator's strong signals, clustering of failure records, and the circuit-breaker
 * predicate. Everything downstream — which rows get written, which alert fires, which override
 * releases what — is the API's business; the semantics are here, where they can be tested without
 * a database.
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

// ── clustering (slice 07) ──────────────────────────────────────────────────────────────────────

/**
 * One recorded locator failure, as the queue sees it: which test failed, which run surfaced it,
 * and the {@link deriveClusterKey} identity of the locator that missed.
 *
 * Deliberately not the fingerprint itself. Clustering is a decision about identity, and identity
 * is the cluster key — passing the whole fingerprint would invite a second, divergent notion of
 * "same failure" to grow in here.
 */
export interface FailureRecord {
  testId: string;
  /** The run the failure was observed in. Null for a failure whose run has been purged. */
  runId?: string | null;
  clusterKey: string;
}

/** A group of failures that are all the same broken locator. */
export interface FailureCluster {
  clusterKey: string;
  /** Distinct tests this cluster covers, in first-seen order — the blast radius of ONE app change. */
  testIds: string[];
  /** Every failure record in the cluster, in the order given. */
  failures: FailureRecord[];
}

/**
 * Group failures by the locator that broke — the whole point of the slice: thirty-eight tests
 * broken by one renamed button are ONE cluster, so they become one job, proposed once and applied
 * across the cluster as a single reviewable change rather than thirty-eight repairs free to
 * diverge from each other.
 *
 * Clusters come back in first-seen order, and so do the failures inside each one, so the oldest
 * failure is the natural anchor (the run a drainer opens its session on). A test that failed twice
 * on the same locator appears once in `testIds` and twice in `failures`: the blast radius is
 * counted in tests, the evidence is kept whole.
 *
 * Unrelated failures do not merge, by construction — different locators derive different keys.
 */
export function clusterFailures(failures: readonly FailureRecord[]): FailureCluster[] {
  const byKey = new Map<string, FailureCluster>();
  for (const failure of failures) {
    let cluster = byKey.get(failure.clusterKey);
    if (!cluster) {
      cluster = { clusterKey: failure.clusterKey, testIds: [], failures: [] };
      byKey.set(failure.clusterKey, cluster);
    }
    cluster.failures.push(failure);
    if (!cluster.testIds.includes(failure.testId)) cluster.testIds.push(failure.testId);
  }
  return [...byKey.values()];
}

// ── the circuit breaker (slice 07) ─────────────────────────────────────────────────────────────

/**
 * How many tests may be simultaneously broken on a locator before repair is suppressed entirely.
 *
 * Ten is chosen to sit above the size of an ordinary drift event and below the size of a bad
 * deploy. A renamed control usually breaks a handful of tests; a broken build, a failed migration
 * or a redesign breaks tens. The cost of the two mistakes is not symmetric — suppressing a repair
 * that would have been fine costs a human five minutes with an override button, while repairing
 * through a bad deploy rewrites the corpus into agreement with a bug and destroys the evidence
 * that it ever happened. So the default errs low.
 */
export const DEFAULT_BREAKER_THRESHOLD = 10;

/**
 * Coerce a stored/untrusted threshold (an `app_settings` string, a request body) to a usable one.
 * Anything that is not a positive integer falls back to {@link DEFAULT_BREAKER_THRESHOLD} — a
 * corrupt setting must not silently disable the guard by reading as `0` or `Infinity`.
 */
export function normalizeBreakerThreshold(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_BREAKER_THRESHOLD;
  const floored = Math.floor(n);
  return floored >= 1 ? floored : DEFAULT_BREAKER_THRESHOLD;
}

/** What the breaker decided, and the numbers it decided from — so a human reading a suppression
 *  can tell a mass rename (many tests, one cluster) from a broken app (many tests, many clusters). */
export interface BreakerVerdict {
  /** True when repair must be suppressed: no jobs at all, the failures recorded instead. */
  tripped: boolean;
  threshold: number;
  /** Distinct tests simultaneously broken on a locator. This is what the threshold compares to. */
  failingTests: number;
  /** How many distinct broken locators those tests are spread across. */
  clusters: number;
}

/**
 * The breaker predicate: is this many simultaneous locator failures a drift event, or an app that
 * broke? Above the threshold it is the latter, and repair is suppressed entirely — mass failure is
 * a human decision, and one bad deploy must not be allowed to rewrite the corpus into agreement
 * with a bug.
 *
 * **Counted in distinct TESTS, not clusters.** A single cluster of forty is exactly the case
 * clustering handles well, so counting clusters would let the largest, most consequential rewrite
 * of all through the guard untouched. `clusters` is reported alongside instead, because it is what
 * tells a human which kind of event this is — and the override exists precisely so that a
 * confirmed mass redesign can be repaired in bulk.
 *
 * Strictly ABOVE the threshold trips it: a threshold of ten means ten simultaneous failures are
 * still repaired and the eleventh is not.
 */
export function breakerVerdict(
  failures: readonly FailureRecord[],
  threshold: number = DEFAULT_BREAKER_THRESHOLD,
): BreakerVerdict {
  const clusters = clusterFailures(failures);
  const failingTests = new Set(failures.map((f) => f.testId)).size;
  const limit = normalizeBreakerThreshold(threshold);
  return {
    tripped: failingTests > limit,
    threshold: limit,
    failingTests,
    clusters: clusters.length,
  };
}
