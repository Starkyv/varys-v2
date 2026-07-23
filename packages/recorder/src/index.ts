import type { Fingerprint, Rect, Step, TestDefinition, Variable, Viewport, Wait } from "@varys/step-schema";

/**
 * `@varys/recorder` is split so its entry (`index.ts`) is the **DOM-free shared core**
 * — pure step factories + the accumulator — that the
 * server-side MCP authoring layer can import without a DOM lib (ADR 0001). The browser
 * DOM-listener driver (`startRecorder`, `CaptureFn`, `CheckpointSpec`, `RecordedSession`)
 * lives in `./dom`, which the Chrome extension imports.
 */

/**
 * The variables a definition declares. The only token left is `{{baseUrl}}` (the entry URL's
 * origin) — there are no data variables or secrets anymore; every typed value is a literal.
 * Kept as the single source of truth so the recorder's `getDefinition` and the extension's save
 * path agree. Self-contained for page injection.
 */
export function variablesFromSteps(steps: Step[]): Variable[] {
  const usesBaseUrl = steps.some((s) => s.type === "navigate" && /\{\{\s*baseUrl\s*\}\}/.test(s.url));
  return usesBaseUrl ? [{ name: "baseUrl", kind: "url" }] : [];
}

/** Longest exact text / accessible name the ranked matcher trusts as a durable
 *  anchor (mirrors locator-engine's TEXT_EXACT_MAX — longer reads as a volatile
 *  content dump, not a label). */
const DURABLE_TEXT_MAX = 180;

/**
 * Would the ranked matcher struggle to re-locate this element on a later run? A
 * fingerprint is *strong* when it carries a durable anchor: a `testId`, an `id`, a
 * `role` + short accessible name, or a short exact `text`. It is *weak* when its
 * only usable signals are **build-hashed CSS-module classes** or a **long/volatile
 * text dump** — a redeploy rotates the hashes and the text changes between runs, so
 * the matcher misses (the briefings-card failure mode). The recorder warns the
 * author at pick time so they can pick a stabler element (or add a data-testid)
 * before saving. Pure + unit-tested; self-contained for page injection.
 */
export function isWeakFingerprint(fp: Fingerprint): boolean {
  if (fp.testId) return false;
  if (fp.attributes?.id) return false;
  if (fp.role && !!fp.accessibleName && fp.accessibleName.length <= DURABLE_TEXT_MAX) return false;
  if (fp.text && fp.text.length <= DURABLE_TEXT_MAX) return false;
  return true; // only hashed module classes and/or a long text dump remain
}

/** Notified for each step the moment it is recorded (used to ship steps to a
 *  navigation-surviving store, so a recording outlives full page loads). */
export type OnStep = (step: Step) => void;

/** Build the recorded entry URL: drop volatile auth/redirect query params, then
 *  parameterize the origin to `{{baseUrl}}`. Falls back to a plain origin-swap when the
 *  href can't be parsed. Self-contained (the volatile-param set is inlined) so it
 *  survives being injected into a page via `.toString()` alongside `startRecorder`. */
export function sanitizeEntryUrl(href: string, origin: string): string {
  // Query params that capture "where to go next" after an auth bounce, or are single-use
  // OAuth/OIDC artifacts. Baked into the entry navigate they'd send a replay to the wrong
  // page (or hang on an expired code), so they're stripped (case-insensitive); real app
  // state (`?tab=`) is kept.
  const VOLATILE = new Set([
    "next", "redirect", "redirect_uri", "redirect_url", "redirecturl", "redirectto",
    "returnurl", "return_to", "returnto", "return", "continue", "from", "dest",
    "destination", "callback", "callbackurl", "goto", "code", "state", "session_state",
    "nonce", "iss", "id_token", "access_token", "prompt", "login_hint",
  ]);
  let cleaned = href;
  try {
    const u = new URL(href);
    for (const key of [...u.searchParams.keys()]) {
      if (VOLATILE.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    cleaned = u.toString();
  } catch {
    // Non-absolute / unparseable href — fall back to the raw value.
  }
  return cleaned.replace(origin, "{{baseUrl}}");
}

/* ─────────────────────────── Shared step-building core ───────────────────────────
 * Pure, DOM-free factories + a driver-agnostic accumulator. BOTH drivers build steps
 * through these — the human DOM-listener driver (`startRecorder`, below) and the
 * server-side MCP agent orchestrator — so AI-authored and human-authored tests are
 * identical in schema and quality by construction (ADR 0001). The factories are
 * self-contained, so they also survive `.toString()` injection on the human path. */

/** A click step from an already-captured fingerprint. */
export function buildClick(target: Fingerprint): Step {
  return { type: "click", target };
}

/** A hover step from an already-captured fingerprint. Emitted (by both drivers) when a hover
 *  reveals content the user then interacts with — so replay re-hovers the trigger first. */
export function buildHover(target: Fingerprint): Step {
  return { type: "hover", target };
}

/** A type step. The value is recorded literally — there are no variables or secrets, so even a
 *  password is stored as typed (everything is a literal on the test). */
export function buildType(target: Fingerprint, value: string): Step {
  return { type: "type", target, value };
}

/** The test's entry navigate (origin → `{{baseUrl}}`, volatile auth params stripped). */
export function buildEntryNavigate(href: string, origin: string): Step {
  return { type: "navigate", url: sanitizeEntryUrl(href, origin) };
}

/** A checkpoint spec AFTER capture — element mode carries an already-captured
 *  `Fingerprint` (not a live element), keeping the accumulator DOM-free. `waitBefore`
 *  (optional) lets a driver attach settle waits ahead of the screenshot. */
export type RecordedCheckpoint =
  | { mode?: "element"; target: Fingerprint; masks?: Rect[]; waitBefore?: Wait[] }
  | { mode: "region"; rect: Rect; masks?: Rect[]; waitBefore?: Wait[] }
  | { mode: "fullpage"; masks?: Rect[]; waitBefore?: Wait[] };

/** A driver-agnostic recording: holds the ordered steps, shapes checkpoints, and
 *  assembles the definition (deriving variables from the recorded tokens). */
export interface Recording {
  push(step: Step): void;
  checkpoint(name: string, spec: RecordedCheckpoint): void;
  getDefinition(name: string, viewport: Viewport): TestDefinition;
  stepCount(): number;
  /** Count of screenshot (checkpoint) steps — for the zero-checkpoint warning. */
  checkpointCount(): number;
}

export function createRecording(onStep?: OnStep): Recording {
  const steps: Step[] = [];
  const push = (s: Step) => {
    steps.push(s);
    onStep?.(s);
  };
  return {
    push,
    checkpoint(name, spec) {
      // Carry masks / waits only when present, so simple checkpoints stay clean (and old
      // definitions without them are unchanged).
      const masks = spec.masks && spec.masks.length ? { masks: spec.masks } : {};
      const waits = spec.waitBefore && spec.waitBefore.length ? { waitBefore: spec.waitBefore } : {};
      // The recorder always records pixel comparison; `context` is authored later in the
      // test-detail editor (it needs a human-written prompt the recorder can't infer).
      if (spec.mode === "fullpage") {
        push({ type: "screenshot", name, captureMode: "fullpage", compareMode: "pixel", ...masks, ...waits });
      } else if (spec.mode === "region") {
        push({ type: "screenshot", name, captureMode: "region", compareMode: "pixel", rect: spec.rect, ...masks, ...waits });
      } else {
        push({ type: "screenshot", name, captureMode: "element", compareMode: "pixel", target: spec.target, ...masks, ...waits });
      }
    },
    getDefinition(name, viewport) {
      // Variables are derived from the recorded tokens — declared once each.
      const variables = variablesFromSteps(steps);
      return { name, viewport, steps: [...steps], ...(variables.length ? { variables } : {}) };
    },
    stepCount() {
      return steps.length;
    },
    checkpointCount() {
      return steps.filter((s) => s.type === "screenshot").length;
    },
  };
}

