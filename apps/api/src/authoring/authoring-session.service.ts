import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { captureFingerprint } from "@varys/capture";
import { environments, runAssertions, runResults, runs, tests as testsTable, testVersions } from "@varys/db";
import { verify, type VerifyOutcome, type VerifyStatus } from "@varys/locator-engine";
import {
  type EnvCookie,
  type EnvironmentProfile,
  type EnvLocalStorageItem,
  performStepAction,
  seedCookies,
  seedLocalStorage,
} from "@varys/runner";
import { resolveStep, resolveWaits } from "@varys/variable-resolver";
import { and, desc, eq, ilike, ne } from "drizzle-orm";
import {
  buildClick,
  buildHover,
  buildEntryNavigate,
  buildType,
  createRecording,
  type Recording,
} from "@varys/recorder";
import {
  describeStep,
  type Fingerprint,
  type Rect,
  type Step,
  streamIdleExpression,
  type TestDefinition,
  type Viewport,
  type Wait,
} from "@varys/step-schema";
import type {
  AuthoringDraftEvent,
  AuthoringFrame,
  AuthoringMode,
  AuthoringSessionSummary,
  EditableWait,
  FingerprintPatch,
  FingerprintSummary,
  NewStepInput,
  TestConfigPatch,
  TestConfigStep,
  TestConfigAssertionPatch,
  TestConfigStepPatch,
} from "@varys/review-contract";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { type Observable, Subject } from "rxjs";
import { DB, type Db } from "../db/db.module";
import { applyFingerprintPatch, hasMatchableSignal } from "../fingerprint-patch";
import { summarizeFingerprint } from "../fingerprint-summary";
import { RepairJobsService } from "../repair-jobs/repair-jobs.service";
import { TestsService } from "../tests/tests.service";

/** How often the idle sweep runs, and how long a session may sit untouched before it is torn
 *  down. Generous: an interactive session legitimately waits on a human between instructions. */
const REAP_INTERVAL_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_MS = 45 * 60 * 1000;

/** Default authoring viewport (desktop) when the caller doesn't specify one. */
const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };

/** Extra Chromium flags from VARYS_BROWSER_ARGS (comma-separated). In containers the
 *  browser runs unprivileged with a small /dev/shm, so set
 *  `--no-sandbox,--disable-dev-shm-usage`. Unset (local/dev) → no extra args. */
function browserLaunchArgs(): string[] {
  return (process.env.VARYS_BROWSER_ARGS ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

/** One element in a perception snapshot — the handle Claude targets actions by. */
export interface SnapshotNode {
  /** Stable ref (e.g. `e7`) — pass to click/type/checkpoint; survives re-snapshots. */
  ref: string;
  /** ARIA role (explicit, else a tag-derived guess). */
  role: string;
  /** Accessible name (aria-label, else first visible text line, else placeholder). */
  name: string;
  tag: string;
  /** The element's own `data-testid`, when it has one — the STRONGEST replay signal (the
   *  matcher scores it far above everything else). Surfaced so the agent can tell a target
   *  that will re-locate deterministically from one that will not, rather than guess. */
  testId?: string;
  /** The element's `id`, when it is author-stable — i.e. it would survive the capture's
   *  `isUsableId` filter (a letter-led plain identifier, not a generated `:r1:` / `tippy-347`).
   *  Second-strongest replay signal. Generated ids are omitted, exactly as capture drops them. */
  id?: string;
  /** True when another node in THIS snapshot shares this node's `role` + `name` and neither
   *  carries a `testId`/`id` to tell them apart. On replay such a target scores a near-tie
   *  against its twin and the matcher refuses to guess (`ambiguous` ⇒ the step hard-fails), so
   *  the agent must disambiguate (row scope / a uniquely-named control) instead of acting. */
  duplicate?: boolean;
  /** Current value for form fields. */
  value?: string;
  /** True for inputs/textareas/selects. */
  editable?: boolean;
}

export interface SnapshotResult {
  url: string;
  title: string;
  nodes: SnapshotNode[];
  /** Base64 PNG, only when requested (`observe` with screenshot=true). */
  screenshot?: string;
}

export interface ActionResult {
  ok: true;
  /** A terse record of what was appended to the test, for Claude's confirmation. `"wait"`
   *  is not a step type — a wait attaches to the NEXT step — so it is reported distinctly
   *  rather than mislabelled as one. */
  recorded: {
    type: Step["type"] | "wait";
    value?: string;
    checkpoint?: string;
    /** For `type: "wait"`: which wait primitive was queued. */
    wait?: Wait["kind"];
    /** True when a pending hover was flushed as a step just before this one (a
     *  hover-reveal → interact flow), so replay re-opens the menu first. */
    hoverFirst?: boolean;
  };
  /** Fresh perception after the action, so Claude can decide the next step. */
  snapshot: SnapshotResult;
}

/** A wait the agent asks for: performed live now AND recorded onto the next step. */
export type AgentWait =
  | { kind: "delay"; ms: number }
  | { kind: "networkIdle"; timeoutMs?: number }
  | { kind: "streamIdle"; quietMs?: number; timeoutMs?: number; busySelector?: string }
  | { kind: "selector"; ref: string; state: "visible" | "hidden"; timeoutMs?: number };

/** How to capture a checkpoint (Slice 4). element ⇒ a ref; region ⇒ a rect; fullpage ⇒ neither.
 *  `compareMode` (+ `prompt` / `threshold`) chooses how it is COMPARED — orthogonal to capture. */
export interface CheckpointInput {
  name: string;
  mode?: "element" | "fullpage" | "region";
  ref?: string;
  rect?: Rect;
  masks?: Rect[];
  /** `pixel` (default) = exact pixel diff; `context` = LLM judge, for generated content. */
  compareMode?: "pixel" | "context";
  /** The judge instruction for `context`. Omitted ⇒ the global default prompt applies. */
  prompt?: string;
  /** Pixel-mode tolerance: max mismatched-pixel ratio (0..1). */
  threshold?: number;
}

/** The matcher's `Page` parameter, taken from `verify` itself: the Authoring Session drives
 *  `playwright-core` while `@varys/locator-engine` is typed against `playwright`. The two are the
 *  same object at runtime (playwright re-exports playwright-core), so this names the target type
 *  for the cast without making the API depend on the `playwright` wrapper package. */
type VerifyPage = Parameters<typeof verify>[0];

/** Which action a locator probe should model — it decides whether the fingerprint is captured
 *  with the actionable-ancestor climb (click/hover/type) or on the exact node (checkpoint). */
export type LocatorProbeAction = "click" | "type" | "checkpoint";

/**
 * How durable the matched signal is — the question `status: "resolved"` does NOT answer. Ordered
 * strongest to weakest:
 *  - `deterministic` — testId / stable id / an attribute-derived accessible name. Survives copy
 *    and data changes.
 *  - `row-scoped` — found as "the control inside the row that says X". Durable exactly as long as
 *    that row text is stable and unique; the probe echoes the text so the caller can judge it.
 *  - `text-bound` — found by visible text. That exact string is baked into the step and must match
 *    verbatim on every future run.
 *  - `fragile` — found only by class names or bounding-box size. No real identity: the matcher is
 *    separating this element from its siblings by shape.
 */
export type LocatorVerdict =
  | "deterministic"
  | "row-scoped"
  | "text-bound"
  | "fragile"
  | "ambiguous"
  | "not-found";

/** One matcher verdict on one fingerprint against one live page — shared by the authoring-time
 *  probe (`verify_locator`, on a live ref) and the repair path (`try_locator`, on a recorded
 *  step's fingerprint), so a locator reads the same either side of a failed Run. */
export interface LocatorAssessment {
  /** Can the matcher find it at all, right now. */
  status: VerifyStatus;
  /** Which signal identified the winner (testId | id | role+name | scope | name | stableClasses | box). */
  matchedSignal: string | null;
  /** True when the win came from a WEAKER signal than the fingerprint's strongest — the stronger
   *  one already fails to match, so the step is one change away from having nothing left. */
  healed: boolean;
  /** How durable that signal is — see {@link LocatorVerdict}. */
  verdict: LocatorVerdict;
  /** What to do about it, in one sentence. */
  advice: string;
}

/** The result of {@link AuthoringSessionService.verifyLocator} — a replay-matcher dry run. */
export interface LocatorProbeResult extends LocatorAssessment {
  ok: true;
  ref: string;
  action: LocatorProbeAction;
  /** The signals this step would actually carry, so the caller can spot volatile content (a
   *  timestamp or a generated title baked into `accessibleName` or `scope.text`). */
  recorded: {
    tag: string;
    testId?: string;
    id?: string;
    role?: string;
    accessibleName?: string;
    nameFromAttr?: boolean;
    scope?: { container: string; text: string };
    stableClasses?: string[];
    size?: { width: number; height: number };
  };
}

/**
 * Turn a matcher outcome + the fingerprint it ran on into a durability verdict and one line of
 * advice. Deliberately separate from `status`: the failure mode this exists to catch is a locator
 * that resolves cleanly today on a signal that cannot survive tomorrow's data.
 */
function locatorVerdict(
  fp: Fingerprint,
  outcome: VerifyOutcome,
): { verdict: LocatorVerdict; advice: string } {
  if (outcome.status === "not-found") {
    return {
      verdict: "not-found",
      advice:
        "The matcher cannot find this element even with it on screen — it carries no signal above the confidence floor. Do NOT record a step against it: target a uniquely-named control instead, reach the state by navigating, or ask for a data-testid on it.",
    };
  }
  if (outcome.status === "ambiguous") {
    return {
      verdict: "ambiguous",
      advice:
        "Two or more elements score as this target, so on replay the matcher refuses to guess and the step hard-fails. Disambiguate: act on a control inside a row with unique, stable text, or on a uniquely-named element — do not record this one.",
    };
  }
  const healedNote = outcome.healed
    ? " It also matched on a weaker signal than the fingerprint's strongest, which means that stronger signal is ALREADY not matching."
    : "";
  switch (outcome.matchedSignal) {
    case "testId":
    case "id":
    case "override":
      return { verdict: "deterministic", advice: `Safe to record — matched on ${outcome.matchedSignal}.${healedNote}` };
    case "role+name":
    case "name":
      return fp.nameFromAttr
        ? {
            verdict: "deterministic",
            advice: `Safe to record — the accessible name comes from an attribute (aria-label/title), which content changes do not touch.${healedNote}`,
          }
        : {
            verdict: "text-bound",
            advice: `Recordable, but "${fp.accessibleName ?? ""}" is baked in from visible text and must match verbatim on every run. Confirm it is fixed UI copy — if it is data (a name, a date, a count, anything generated), pick a different target.${healedNote}`,
          };
    case "scope":
      return {
        verdict: "row-scoped",
        advice: `Recordable — anchored on the row containing "${fp.scope?.text ?? ""}". That text must be unique and identical on every run; if it is per-run or per-environment data, pick a row that is not.${healedNote}`,
      };
    default:
      return {
        verdict: "fragile",
        advice: `Matched only on ${outcome.matchedSignal ?? "shape"} — class names and element size are not identity, so replay will pick a sibling of the same shape as soon as the layout or the data shifts. Do not record this: target a named control, or ask for a data-testid.${healedNote}`,
      };
  }
}

/**
 * Resolve a fingerprint's `{{tokens}}` the way a Run would, by round-tripping it through the
 * step it belongs to (`resolveStep` is the single definition of token substitution, and it
 * operates on steps). Used by the repair path so a candidate locator is judged against the same
 * resolved values replay would use, not the raw `{{baseUrl}}`-style text.
 */
function resolveFingerprintTokens(
  fp: Fingerprint,
  step: Step,
  profile: EnvironmentProfile,
): Fingerprint {
  const resolved = resolveStep({ ...step, target: fp } as Step, profile);
  return ("target" in resolved ? resolved.target : undefined) ?? fp;
}

/**
 * What a repair session is parked on: the failed Run, the exact definition VERSION that ran, and
 * the step being diagnosed. Held on the session so a candidate locator can be merged onto the
 * right step and re-checked against the parked page without re-reading the DB or re-driving.
 */
export interface RepairContext {
  runId: string;
  testId: string;
  testName: string;
  /** The version that RAN — not necessarily the test's latest; a diagnosis must reproduce the
   *  failure, and the latest version may already differ. */
  version: number;
  environmentName: string;
  profile: EnvironmentProfile | null;
  definition: TestDefinition;
  /** The step under diagnosis (0-based) — the run's `failedStepIndex` unless overridden. */
  stepIndex: number;
  /** How far THIS re-drive got. Below `stepIndex` ⇒ the path broke upstream and the step under
   *  diagnosis was never reached, which is a different bug from "this locator is wrong". */
  reachedStep: number;
  /** The step this re-drive died on, when it stopped short of `stepIndex`. */
  brokeAt: { index: number; label: string } | null;
  /** The original run's error, for comparison against what we just reproduced. */
  runError: string | null;
  /** The step the RUN died on — distinct from `stepIndex`, which is wherever the session is
   *  currently parked (a repair moves around the test; the run's verdict does not). */
  runFailedStepIndex: number | null;
}

/** What `open_repair_session` hands back: why the run failed, what the step was looking for, what
 *  the page actually offers now, and the matcher's verdict on the recorded locator as it stands. */
export interface RepairSessionResult {
  sessionId: string;
  mode: "repair";
  run: { id: string; error: string | null; failedStepIndex: number | null };
  test: { id: string; name: string; version: number; environment: string };
  /** The step being diagnosed, and where it sits in the test. */
  step: { index: number; of: number; label: string; type: Step["type"] };
  /** Whether this re-drive reproduced the original failure, and where it actually stopped. */
  replay: { reachedStep: number; brokeAt: { index: number; label: string } | null; reproduced: boolean; note: string };
  /** What the recorded locator was looking for (null for steps with no element target). */
  recordedLocator: FingerprintSummary | null;
  /** The matcher's verdict on that recorded locator against the page as it is NOW — the answer to
   *  "why is this step failing". Null when the step has no element target, or when the re-drive
   *  never reached the step (nothing meaningful to resolve against). */
  diagnosis: LocatorAssessment | null;
  url: string;
  title: string;
  /** Everything actionable on the parked page, with identity + duplicate flags. */
  nodes: SnapshotNode[];
  /** Base64 PNG of the parked page. */
  screenshot: string;
  guidance: string;
}

/** The result of trying one candidate locator against the parked page. */
export interface TryLocatorResult extends LocatorAssessment {
  ok: true;
  stepIndex: number;
  /** The merged candidate, as the step would carry it if this patch were saved. */
  candidate: FingerprintSummary | null;
  /** The exact edit this represents, echoed back so the caller can report it verbatim. */
  patch: FingerprintPatch;
  /** Whether this candidate is an improvement worth proposing to the user. */
  recommend: boolean;
}

/** The result of writing a verified fix onto the test. */
export interface ApplyFixResult {
  ok: true;
  testId: string;
  stepIndex: number;
  /** The new test_version's id — what the review surface addresses it by. */
  versionId: string;
  /** The new test_version the fix was written as. The version it replaced is retained, so the
   *  edit is auditable and recoverable rather than destructive. */
  version: number;
  /** The version it was applied on top of. */
  baseVersion: number;
  patch: FingerprintPatch;
  /** The verdict that authorised the write — an unresolvable candidate is never written. */
  verdict: LocatorVerdict;
  matchedSignal: string | null;
  /** Set when the fix resolves but on a signal that will not last, so the caller reports the
   *  caveat instead of declaring the test fixed. */
  warning: string | null;
  summary: string;
}

/** One step's worth of edit in {@link AuthoringSessionService.editTest}. Every field is optional
 *  and addresses one thing on the step at `index`; omitted fields are left exactly as they are. */
export interface TestEditStep {
  /** 0-based index of the step to edit, as reported by `read_test`. */
  index: number;
  /** Delete this step. The entry navigation (index 0) can't be removed. */
  remove?: boolean;
  /** Screenshot-only: rename the checkpoint (the baselines follow the name). */
  name?: string;
  captureMode?: "element" | "fullpage" | "region";
  rect?: Rect;
  compareMode?: "pixel" | "context";
  prompt?: string;
  threshold?: number;
  masks?: Rect[];
  /** Navigate-only: the URL to go to. */
  url?: string;
  /** Type-only: the literal value typed into the field. */
  value?: string;
  /** Replace this step's authorable waits (recorded selector waits are preserved). */
  waitBefore?: EditableWait[];
  /** Drop recorded selector waits by their position among this step's selector waits. */
  dropRecordedWaits?: number[];
  /** Re-capture this step's locator from the element `ref` on the session's live page. */
  ref?: string;
  /** Patch the step's locator signals (merged onto the recorded fingerprint). */
  locator?: FingerprintPatch;
}

/**
 * An edit to one declared Assertion, keyed by its STABLE id (Slice 19, slices 09 + 10).
 *
 * `left` / `right` are how an assertion whose extraction target no longer resolves is REPAIRED: a
 * locator patch on that side's fingerprint, merged exactly as a step's is. The id is never
 * patchable — it is the identity the assertion's history hangs off.
 */
export interface TestEditAssertion {
  id: string;
  /** Rewrite the plain-language check text. */
  check?: string;
  /** Patch the LEFT side's extraction target (merged onto the recorded fingerprint). */
  left?: FingerprintPatch;
  /** Patch the RIGHT side's extraction target. Refused when that side is a literal value. */
  right?: FingerprintPatch;
  /** Delete this assertion, and with it every future verdict under its id. */
  remove?: boolean;
}

/** A step to add, addressed either by a live page `ref` (a full captured fingerprint) or by a
 *  raw `selector` (used as-is, no bundle behind it). */
export interface TestEditInsertStep {
  type: "navigate" | "click" | "hover" | "type" | "screenshot";
  url?: string;
  ref?: string;
  selector?: string;
  value?: string;
  name?: string;
  captureMode?: "element" | "fullpage" | "region";
  rect?: Rect;
  compareMode?: "pixel" | "context";
  prompt?: string;
  threshold?: number;
  masks?: Rect[];
}

export interface TestEditInsert {
  /** The existing step this insert is anchored to, by its CURRENT 0-based index. */
  atIndex: number;
  position: "above" | "below";
  step: TestEditInsertStep;
}

/** An arbitrary edit to a test: any step, any field, plus structure (add / remove / reorder). */
export interface TestEditInput {
  /** Who is making the edit. Only consulted when there is no `sessionId` to read the owner off:
   *  an AGENT's write lands unreviewed wherever it comes from (Slice 19, slice 04). */
  actor?: SessionActor;
  /** An open repair session — supplies the test being repaired, and the live page a `ref` names. */
  sessionId?: string;
  /** The test to edit, when not editing the one a session is repairing. */
  testId?: string;
  name?: string;
  notes?: string;
  /** Replace the test-level default waits applied before every wait-supporting step. */
  defaults?: EditableWait[];
  steps?: TestEditStep[];
  inserts?: TestEditInsert[];
  /** The new order of the surviving steps, by their current 0-based index. */
  order?: number[];
  /** Edits to the test's declared Assertions, keyed by each one's stable id. */
  assertions?: TestEditAssertion[];
}

export interface TestEditResult {
  ok: true;
  testId: string;
  /** The new test_version's id, or empty for a name/notes-only edit that wrote none. */
  versionId: string;
  /** The version the edit was written as (unchanged for a name/notes-only edit). */
  version: number;
  /** The version it was applied on top of, which is retained. */
  baseVersion: number;
  /** What was actually applied, in plain words, so it can be reported back verbatim. */
  changes: string[];
  /** The test's steps AFTER the edit — indices shift when steps are added, removed or reordered,
   *  so a follow-up edit must be keyed off these, not off the list read before. */
  steps: Record<string, unknown>[];
  note: string;
}

/**
 * A hover awaiting a verdict. The human recorder emits a hover step only when hovering a
 * trigger REVEALED content the user then interacted with (`dom.ts` → `openerForRevealed`);
 * recording every hover would bury real steps in exploration noise. The MCP driver gets the
 * same selectivity from `revealedRefs`: the refs that appeared *because* of this hover. If the
 * next click/type targets one of them, the hover was load-bearing and is flushed as a step
 * ahead of it; otherwise it is dropped.
 */
interface PendingHover {
  target: Fingerprint;
  /** Refs present after the hover but not before it — i.e. what the hover revealed. */
  revealedRefs: Set<string>;
}

/** Which issuer an action came from — mirrors `McpPrincipalKind` without importing it, so the
 *  session service keeps no dependency on the MCP transport. */
export type SessionActorKind = "user" | "agent";

/** Who is driving one call, when there is no session to read it off (an `edit_test` addressed by
 *  `testId` alone). `kind` is what decides whether the version it writes needs review. */
export interface SessionActor {
  id: string;
  email: string;
  kind: SessionActorKind;
}

interface SessionState {
  /** The better-auth user id that opened this session (Slice 16 — per-user MCP auth).
   *  Every read and every action is gated on it, so one user's server-side browser is
   *  invisible and undrivable to another. */
  ownerId: string;
  /** The owner's email — written as the draft's `createdBy` on finish. */
  ownerEmail: string;
  /** Which ISSUER opened it (ADR-0005): a human who completed the browser OAuth leg, or an
   *  unattended Repair Agent. Every version an `agent` session writes lands UNREVIEWED, so the
   *  kind has to travel with the session rather than be re-derived at write time. */
  ownerKind: SessionActorKind;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  rec: Recording;
  viewport: Viewport;
  name: string;
  intent: string | null;
  mode: AuthoringMode;
  /** Waits requested since the last recorded step — drained onto the next step's waitBefore. */
  pendingWaits: Wait[];
  /** The last hover, held until we know whether it was load-bearing (see `hover`). */
  pendingHover?: PendingHover;
  /** Last time a tool touched this session — the idle reaper's input. */
  lastActivityAt: number;
  /** Reference screenshots captured at each checkpoint (name → PNG) — the promote-view
   *  previews, persisted on finish. A Map so a re-checkpointed name keeps the latest. */
  previews: Map<string, Buffer>;
  /** Set ONLY on a repair session: what failed Run/step this browser is parked on. Its presence
   *  is what makes the session diagnostic rather than recording — `finish` and `checkpoint` refuse
   *  it, because nothing here is meant to become a test. */
  repair?: RepairContext;
  /** Monotonic live-preview frame counter, and the latest frame so a viewer that subscribes
   *  mid-session paints immediately (Slice 15 — Author with AI). */
  frameSeq: number;
  lastFrame?: AuthoringFrame;
}

export interface OpenSessionInput {
  /** The authenticated MCP user opening this session (Slice 16). Supplied by the
   *  controller from the OAuth bearer token — never by the model. */
  owner: { id: string; email: string };
  startUrl: string;
  name?: string;
  intent?: string;
  /** How Claude will drive this session. REQUIRED — no default; open() rejects a missing or
   *  invalid mode so the choice is always explicit, never inferred. See AuthoringMode. */
  mode?: AuthoringMode;
  viewport?: Partial<Viewport>;
}

export interface OpenSessionResult {
  sessionId: string;
  url: string;
  title: string;
  nodes: SnapshotNode[];
  /** The mode this session was opened in (echoed so the agent can confirm it stuck). */
  mode: AuthoringMode;
  /** Mode-specific steering for the rest of this session — reasserted here because the MCP
   *  `initialize` instructions are global/once, while this lands right when work begins. */
  guidance: string;
}

/** Per-mode steering returned from open_session, anchoring how Claude proceeds. The checkpoint
 *  discipline (only on an explicit request) holds in BOTH modes — see authoring-instructions. */
function modeGuidance(mode: AuthoringMode): string {
  if (mode === "repair") {
    return [
      "Repair mode: this session records no NEW test — it opens an EXISTING one for diagnosis and editing. The browser has been driven through the test's own steps to the point the Run failed and parked there, so the page in front of you is the page the failing step faced.",
      "Diagnose first: read `diagnosis` (the matcher's verdict on the recorded locator), compare `recordedLocator` against the `nodes` actually on the page, and use observe/hover to look around. `goto_step` re-drives to any other step when the problem is not where the Run said it was.",
      "Then fix it. For a broken locator, try_locator → apply_fix: the candidate is re-checked against this live page and refused unless it resolves, which is the one edit that must never be a guess.",
      "For everything else, read_test and edit_test can change ANY part of the test — a checkpoint's name, capture mode, compare mode, judge prompt, threshold or masks; a typed value; a navigate URL; waits; adding, removing or reordering steps; re-capturing a step's element off the live page. Same write path as the web editor: a new audited version, previous version retained.",
      "Do only what the user asked for, and say afterwards exactly what you changed and the new version number. edit_test is not verified against the page the way apply_fix is, so when you edit a locator through it, check it with try_locator (and goto_step to re-drive) rather than declaring it fixed.",
    ].join(" ");
  }
  return mode === "batch"
    ? "Batch mode: execute the whole plan to completion without pausing for confirmation between steps. Take a checkpoint ONLY where the plan explicitly asks for one (e.g. 'screenshot', 'capture', 'snapshot', 'checkpoint', 'verify this screen') — never add one on your own. When every step in the plan is done, call finish_session to save the draft."
    : "Step-by-step mode: perform ONLY the single action just requested, then stop and report what you did and what the page now shows. Do not run ahead to later steps. Take a checkpoint only when explicitly told to. NEVER end the session on your own: it ends ONLY when the user explicitly tells you to finish or save it (e.g. \"finish the session\", \"we're done\", \"save it\"). When they do, call finish_session with confirm: true — the server refuses finish_session on an interactive session without that confirmation.";
}

export interface FinishResult {
  testId: string;
  version: number;
  checkpointCount: number;
  /** Set when the draft asserts nothing (zero checkpoints) — surfaced to Claude. */
  warning: string | null;
}

/**
 * In-page perception: assign a stable `data-varys-ref` to each visible interactive /
 * landmark element and return a compact node list. Self-contained (no outer refs, no
 * inner named functions) so it serializes cleanly into the page via `page.evaluate`.
 */
function collectSnapshot(): { nodes: SnapshotNode[] } {
  const SEL =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [contenteditable=""], [contenteditable="true"], [onclick], h1, h2, h3, [role="heading"]';
  const w = window as unknown as { __varysRef?: number };
  let counter = w.__varysRef ?? 0;
  const nodes: SnapshotNode[] = [];

  // Pass 1: semantic interactive/landmark elements (above). Pass 2: click-handler
  // containers — cards, list rows, tiles built as `<div onClick>` with no role/href
  // (common in React apps; e.g. the DataGenie brief cards). We detect them by computed
  // `cursor: pointer` and keep only the OUTERMOST pointer element of each subtree (its
  // parent isn't also pointer), so we tag the whole clickable tile rather than every
  // nested span. Deduped by element identity so refs already assigned in pass 1 — or by
  // a prior observe — are reused, never dropped.
  const candidates: Element[] = [];
  const seen = new Set<Element>();
  for (const el of Array.from(document.querySelectorAll(SEL))) {
    if (!seen.has(el)) { seen.add(el); candidates.push(el); }
  }
  // Containers (cards/rows/tiles) AND clickable leaves (icon spans/imgs/svgs). `cursor`
  // inherits, so a descendant of a pointer card also computes pointer; skipping when the
  // parent is pointer keeps the OUTERMOST clickable per subtree (the card, not its spans),
  // while a standalone clickable leaf whose parent isn't pointer is still surfaced.
  for (const el of Array.from(
    document.querySelectorAll("div, span, li, article, section, td, tr, p, label, img, svg"),
  )) {
    if (seen.has(el)) continue;
    if (getComputedStyle(el).cursor !== "pointer") continue;
    const p = el.parentElement;
    if (p && getComputedStyle(p).cursor === "pointer") continue;
    seen.add(el);
    candidates.push(el);
  }

  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") {
      continue;
    }
    let ref = el.getAttribute("data-varys-ref");
    if (!ref) {
      counter += 1;
      ref = `e${counter}`;
      el.setAttribute("data-varys-ref", ref);
    }
    const tag = el.tagName.toLowerCase();
    const typeAttr = (el.getAttribute("type") || "").toLowerCase();
    let role = el.getAttribute("role") || "";
    if (!role) {
      if (tag === "a") role = "link";
      else if (tag === "button") role = "button";
      else if (tag === "select") role = "combobox";
      else if (tag === "textarea") role = "textbox";
      else if (tag === "input")
        role = typeAttr === "checkbox" ? "checkbox" : typeAttr === "radio" ? "radio" : typeAttr === "submit" || typeAttr === "button" ? "button" : "textbox";
      else if (tag === "h1" || tag === "h2" || tag === "h3") role = "heading";
      else if (cs.cursor === "pointer") role = "button";
      else role = tag;
    }
    const aria = (el.getAttribute("aria-label") || "").trim();
    const placeholder = (el.getAttribute("placeholder") || "").trim();
    const innerText = ((el as HTMLElement).innerText || el.textContent || "").trim();
    const firstLine = innerText.split("\n").map((s) => s.trim()).find((s) => s.length > 0) || "";
    const node: SnapshotNode = { ref, role, name: (aria || firstLine || placeholder).slice(0, 120), tag };
    // Identity signals, surfaced so the agent can judge whether a target will re-locate on
    // replay instead of inferring it from role/name alone. `id` is filtered by the same rule
    // `@varys/capture` applies (letter-led plain identifier, not a library-generated one) —
    // an id that capture would drop must not read here as a durable signal.
    const testId = (el.getAttribute("data-testid") || "").trim();
    if (testId) node.testId = testId;
    const rawId = (el.getAttribute("id") || "").trim();
    if (rawId && /^[A-Za-z][\w-]*$/.test(rawId) && !/^tippy-\d+$/.test(rawId)) node.id = rawId;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      node.editable = true;
      node.value = (el as HTMLInputElement).value || "";
    }
    nodes.push(node);
  }

  // Ambiguity pre-flight: the replay matcher refuses to act when the top two candidates score
  // within a few points, and two same-role/same-name elements with no testId/id to separate them
  // are exactly that tie. Flag them HERE, while the agent can still pick a different target —
  // by the time a Run hits it, the step is already recorded and the failure is a hard one.
  // Blank names are not flagged: they are unaddressable on their own terms (see the authoring
  // instructions), not merely ambiguous.
  const byIdentity = new Map<string, SnapshotNode[]>();
  for (const n of nodes) {
    if (!n.name || n.testId || n.id) continue;
    const key = `${n.role}\u0000${n.name}`;
    const bucket = byIdentity.get(key);
    if (bucket) bucket.push(n);
    else byIdentity.set(key, [n]);
  }
  for (const bucket of Array.from(byIdentity.values())) {
    if (bucket.length > 1) for (const n of bucket) n.duplicate = true;
  }

  w.__varysRef = counter;
  return { nodes };
}

/**
 * Drives Claude's authoring sessions: launches a server-side Playwright browser, holds it
 * across MCP tool calls, perceives the page (aria-style snapshot with stable refs), and
 * builds steps through the shared `@varys/recorder` core so AI-authored tests are identical
 * to human recordings by construction (ADR 0001). Fingerprints are captured in-page by
 * reusing `@varys/capture`'s `captureFingerprint`, serialized via the same `new Function` +
 * `__name`-shim harness the locator engine uses. The MCP controller is a thin transport over
 * this service; tests drive it deterministically (no LLM).
 */
@Injectable()
export class AuthoringSessionService implements OnApplicationShutdown {
  private readonly log = new Logger(AuthoringSessionService.name);
  private readonly sessions = new Map<string, SessionState>();
  /** Sweeps abandoned sessions. Every open session pins a headless Chromium, and a client can
   *  simply go away (Claude Code quits, the network drops) — the MCP transport is stateless HTTP,
   *  so there is no disconnect to react to. Without this, every abandoned session leaks a browser
   *  for the process's lifetime, and each user can leak their own. */
  private readonly reaper = setInterval(() => void this.reapIdle(), REAP_INTERVAL_MS).unref();
  /** Live-preview frames across all sessions; the live-preview controller filters by sessionId.
   *  A human-only channel — these frames are never fed to the model. */
  private readonly liveFrames = new Subject<AuthoringFrame>();
  /** Terminal authoring events (a Draft created on finish), for the web review hand-off. */
  private readonly sessionEvents = new Subject<AuthoringDraftEvent>();

  constructor(
    @Inject(TestsService) private readonly tests: TestsService,
    @Inject(DB) private readonly db: Db,
    // Only ever asked one question: which Repair Job is this agent's write being made under?
    // (Slice 19, slice 04 — a version awaiting review has to be traceable to the failure it
    // claims to fix.) A human principal never reaches it.
    @Inject(RepairJobsService) private readonly repairJobs: RepairJobsService,
  ) {}

  /**
   * The test an open repair session is addressing, or null. The MCP layer needs it to re-check an
   * AGENT's claim on every session-addressed tool call: a session was opened under a claim, but
   * that claim can be released or lapse while the browser is still parked, and a repair tool that
   * kept working off the session id alone would outlive the licence it was opened under.
   */
  sessionTestId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.repair?.testId ?? null;
  }

  /**
   * How a write by `actor` on `testId` should be recorded (Slice 19, slice 04): an unattended
   * Repair Agent's version lands `unreviewed` and carries the job it was written under; a human's
   * lands as it always has, because the person writing it has already reviewed it.
   */
  private async reviewFor(
    actor: { id: string; kind: SessionActorKind } | undefined,
    testId: string,
  ): Promise<{ unreviewed: boolean; repairJobId: string | null } | undefined> {
    if (actor?.kind !== "agent") return undefined;
    return { unreviewed: true, repairJobId: await this.repairJobs.claimedJobId(actor.id, testId) };
  }

  async open(input: OpenSessionInput): Promise<OpenSessionResult> {
    const startUrl = (input.startUrl ?? "").trim();
    if (!startUrl) throw new BadRequestException("startUrl is required");
    if (input.mode !== "interactive" && input.mode !== "batch") {
      throw new BadRequestException(
        'open_session requires an explicit mode: "interactive" (you carry out one user instruction at a time and end only when the user says so) or "batch" (you run a plan/instructions file end-to-end, then finish). Do not default — if the user did not make the mode clear, ask them which they want before opening the session.',
      );
    }
    const viewport: Viewport = { ...DEFAULT_VIEWPORT, ...input.viewport };

    const browser = await chromium.launch({ headless: true, args: browserLaunchArgs() });
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    try {
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw new BadRequestException(`could not open ${startUrl}: ${(err as Error).message}`);
    }

    const rec = createRecording();
    const href = page.url();
    rec.push(buildEntryNavigate(href, new URL(href).origin));

    const sessionId = randomUUID();
    const mode: AuthoringMode = input.mode;
    this.sessions.set(sessionId, {
      ownerId: input.owner.id,
      ownerEmail: input.owner.email,
      // An AUTHORING session is always a human's: `open_session` is absent from the agent
      // toolset (ADR-0005), because an agent that could open one could invent tests unattended.
      ownerKind: "user",
      browser,
      context,
      page,
      rec,
      viewport,
      name: input.name?.trim() || "authored test",
      intent: input.intent?.trim() || null,
      mode,
      pendingWaits: [],
      lastActivityAt: Date.now(),
      previews: new Map(),
      frameSeq: 0,
    });
    this.log.log(
      `opened authoring session ${sessionId} on ${href} (${mode}) for ${input.owner.email}`,
    );
    const { nodes } = await page.evaluate(collectSnapshot);
    await this.emitFrame(sessionId, { type: "navigate" });
    return { sessionId, url: href, title: await page.title(), nodes, mode, guidance: modeGuidance(mode) };
  }

  /** The newest failed Run for a test — how `openRepair` accepts a test id instead of a run id.
   *  Throws (rather than returning null) so the caller gets the real reason: no such test, or a
   *  test that has simply never failed. */
  private async latestFailedRun(testId: string | undefined): Promise<string> {
    const id = testId?.trim();
    if (!id) {
      throw new BadRequestException("Pass a runId, or a testId to diagnose that test's most recent failure.");
    }
    const [row] = await this.db
      .select({ runId: runs.id, name: testsTable.name })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(testsTable, eq(testsTable.id, testVersions.testId))
      .where(and(eq(testVersions.testId, id), eq(runs.status, "failed")))
      .orderBy(desc(runs.updatedAt))
      .limit(1);
    if (!row) {
      throw new NotFoundException(
        `No failed run found for test ${id} — either the id is wrong, or this test has not failed. Use failed_runs to see what has.`,
      );
    }
    return row.runId;
  }

  /**
   * Recent failed Runs, so a repair can start from "the dashboard test that broke last night"
   * rather than from a run id someone has to go and find. Read-only.
   */
  async recentFailures(opts?: { testId?: string; testName?: string; limit?: number }): Promise<
    Array<{
      runId: string;
      testId: string;
      testName: string;
      failedAt: string;
      failedStepIndex: number | null;
      failedStep: string | null;
      error: string | null;
    }>
  > {
    const name = opts?.testName?.trim();
    const forTest = opts?.testId?.trim();
    const rows = await this.db
      .select({
        runId: runs.id,
        testId: testVersions.testId,
        testName: testsTable.name,
        failedAt: runs.updatedAt,
        failedStepIndex: runs.failedStepIndex,
        error: runs.error,
        definition: testVersions.definition,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(testsTable, eq(testsTable.id, testVersions.testId))
      .where(
        and(
          eq(runs.status, "failed"),
          ...(forTest ? [eq(testVersions.testId, forTest)] : []),
          ...(name ? [ilike(testsTable.name, `%${name}%`)] : []),
        ),
      )
      .orderBy(desc(runs.updatedAt))
      .limit(Math.min(Math.max(opts?.limit ?? 10, 1), 50));

    return rows.map((r) => {
      const steps = (r.definition as TestDefinition).steps;
      const step = r.failedStepIndex != null ? steps[r.failedStepIndex] : undefined;
      return {
        runId: r.runId,
        testId: r.testId,
        testName: r.testName,
        failedAt: r.failedAt.toISOString(),
        failedStepIndex: r.failedStepIndex,
        failedStep: step ? describeStep(step) : null,
        error: r.error,
      };
    });
  }

  /**
   * Open a REPAIR session on a failed Run: re-drive the test's own steps, with the same drive
   * primitive a Run uses, up to the step that failed — then stop and hold the browser there.
   *
   * This is the diagnostic counterpart to authoring. A failed Run tells you a step could not be
   * located; it cannot tell you WHY, because by the time anyone looks the browser is gone. Here
   * the page the failing step faced is still on screen and still driveable, so the recorded
   * fingerprint can be resolved against it, the live alternatives listed, and candidate fixes
   * tried — see {@link tryLocator}.
   *
   * It replays the definition VERSION the run actually used, not the test's latest, so the
   * failure being diagnosed is the one that happened.
   *
   * Nothing is recorded and nothing is saved: `finish` and `checkpoint` refuse a repair session.
   * The output is a diagnosis for a human to act on in the locator editor — Claude proposes,
   * a person edits (ADR 0001).
   */
  /**
   * The step of the first RED checkpoint on a run, or -1.
   *
   * The join point is the checkpoint name, which is the screenshot step's name — the same key
   * `run_results` uses. Ordered by the step's own position rather than by insertion, so "the first
   * failure" means the first one the run reached.
   */
  private async firstRedCheckpointStep(runId: string, definition: TestDefinition): Promise<number> {
    const rows = await this.db
      .select({ name: runResults.checkpointName })
      .from(runResults)
      .where(and(eq(runResults.runId, runId), eq(runResults.reviewState, "diff")));
    if (rows.length === 0) return -1;
    const red = new Set(rows.map((r) => r.name));
    for (const [index, step] of definition.steps.entries()) {
      if (step.type === "screenshot" && red.has(step.name)) return index;
    }
    return -1;
  }

  /**
   * Where to park a run that failed at no step: the first red CHECKPOINT's step, else — when a
   * failing ASSERTION is what made it red — the last step, which is the page the assertions were
   * evaluated against. -1 when neither applies.
   */
  private async firstRedCheckpointStepOrAssertionPage(
    runId: string,
    definition: TestDefinition,
  ): Promise<number> {
    const red = await this.firstRedCheckpointStep(runId, definition);
    if (red >= 0) return red;
    const [failing] = await this.db
      .select({ assertionId: runAssertions.assertionId })
      .from(runAssertions)
      .where(and(eq(runAssertions.runId, runId), ne(runAssertions.outcome, "passed")))
      .limit(1);
    if (!failing) return -1;
    return definition.steps.length - 1;
  }

  async openRepair(input: {
    owner: { id: string; email: string; kind?: SessionActorKind };
    runId?: string;
    /** Alternative entry point: diagnose this test's MOST RECENT failure. The test id is what a
     *  user has to hand (it is in the web app's URL); a run id usually means going to look one up. */
    testId?: string;
    stepIndex?: number;
  }): Promise<RepairSessionResult> {
    const runId = (input.runId ?? "").trim() || (await this.latestFailedRun(input.testId));

    const [row] = await this.db
      .select({
        error: runs.error,
        failedStepIndex: runs.failedStepIndex,
        environmentId: runs.environmentId,
        testId: testVersions.testId,
        version: testVersions.version,
        definition: testVersions.definition,
        testName: testsTable.name,
      })
      .from(runs)
      .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
      .innerJoin(testsTable, eq(testsTable.id, testVersions.testId))
      .where(eq(runs.id, runId))
      .limit(1);
    if (!row) throw new NotFoundException(`Run ${runId} not found`);

    const definition = row.definition as TestDefinition;
    // Which step to park on. A caller may override to inspect an earlier step (e.g. the one that
    // ACTUALLY broke when the drive stops short), but by default it is the run's own verdict.
    //
    // A run can be red WITHOUT failing at a step: a pixel regression or a failed judge finishes
    // every step and comes back `needs_review` with a red checkpoint. Those are exactly the
    // failures a Triage Job diagnoses (Slice 19, slice 08), and "drive to the failure and look" has
    // to mean something for them too — so fall back to the first red CHECKPOINT's screenshot step
    // rather than making a drainer guess an index for a failure Varys already located.
    // An ASSERTION failure (Slice 19, slices 09/10) is a third shape again: every step ran, no
    // checkpoint is red, and the assertion was evaluated against the page as the LAST step left it.
    // So that is where a drainer is parked — the page the assertion actually looked at — rather
    // than being told there is nothing to park on when Varys knows perfectly well where to look.
    const stepIndex =
      input.stepIndex ??
      row.failedStepIndex ??
      (await this.firstRedCheckpointStepOrAssertionPage(runId, definition));
    if (stepIndex < 0) {
      throw new BadRequestException(
        `Run ${runId} did not fail at a step and has no red checkpoint (error: ${row.error ?? "none"}), so there is nothing to park on. Pass an explicit stepIndex to inspect a specific step anyway.`,
      );
    }
    if (stepIndex >= definition.steps.length) {
      throw new BadRequestException(
        `Step ${stepIndex} is out of range — this test version has ${definition.steps.length} steps.`,
      );
    }

    // The run's environment supplies {{baseUrl}} plus the cookies/localStorage that get it past
    // login. Without them the re-drive would fail at step 1 for reasons unrelated to the bug.
    let environmentName = "default";
    let profile: EnvironmentProfile | null = null;
    let cookies: EnvCookie[] = [];
    let localStorage: EnvLocalStorageItem[] = [];
    if (row.environmentId) {
      const [env] = await this.db
        .select({
          name: environments.name,
          baseUrl: environments.baseUrl,
          cookies: environments.cookies,
          localStorage: environments.localStorage,
        })
        .from(environments)
        .where(eq(environments.id, row.environmentId))
        .limit(1);
      if (env) {
        environmentName = env.name;
        profile = { baseUrl: env.baseUrl ?? "" };
        cookies = (env.cookies ?? []) as EnvCookie[];
        localStorage = (env.localStorage ?? []) as EnvLocalStorageItem[];
      }
    }

    const viewport: Viewport = { ...DEFAULT_VIEWPORT, ...definition.viewport };
    const browser = await chromium.launch({ headless: true, args: browserLaunchArgs() });
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      reducedMotion: "reduce",
    });
    let page: Page;
    let reachedStep = 0;
    let brokeAt: { index: number; label: string } | null = null;
    try {
      await seedCookies(context, cookies, profile);
      await seedLocalStorage(context, localStorage, profile);
      page = await context.newPage();

      const drive = await this.driveTo(page, definition, profile, stepIndex);
      reachedStep = drive.reachedStep;
      brokeAt = drive.brokeAt;
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw new BadRequestException(
        `could not start the repair drive for run ${runId}: ${(err as Error).message}`,
      );
    }

    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      ownerId: input.owner.id,
      ownerEmail: input.owner.email,
      ownerKind: input.owner.kind ?? "user",
      browser,
      context,
      page,
      rec: createRecording(),
      viewport,
      name: `repair: ${row.testName}`,
      intent: null,
      mode: "repair",
      repair: {
        runId,
        testId: row.testId,
        testName: row.testName,
        version: row.version,
        environmentName,
        profile,
        definition,
        stepIndex,
        reachedStep,
        brokeAt,
        runError: row.error,
        runFailedStepIndex: row.failedStepIndex,
      },
      pendingWaits: [],
      lastActivityAt: Date.now(),
      previews: new Map(),
      frameSeq: 0,
    });
    this.log.log(
      `opened repair session ${sessionId} on run ${runId} (step ${stepIndex}, reached ${reachedStep}) for ${input.owner.email}`,
    );
    return this.repairView(sessionId);
  }

  /**
   * Re-park a repair session on a DIFFERENT step: re-drive the test's steps from the top and stop
   * there. The counterpart to `open_repair_session`'s fixed landing spot — needed because a repair
   * is rarely confined to the one step a Run happened to die on. The path may have broken earlier;
   * a fix may need checking one step later; the user may simply want to change step 7.
   *
   * It re-drives the definition the session is CURRENTLY holding, which is the one `editTest` has
   * been writing to — so after an edit this is also how you see the edit take effect.
   *
   * A fresh page in the same (already seeded) context, rather than the dirty one: re-driving on top
   * of whatever the last drive left behind would make the parked state depend on where you had been
   * before, which is exactly the kind of thing a diagnosis must not inherit.
   */
  async gotoStep(sessionId: string, stepIndex: number): Promise<RepairSessionResult> {
    const s = this.require(sessionId);
    const repair = s.repair;
    if (!repair) {
      throw new BadRequestException(
        "goto_step only works in a repair session — open one with open_repair_session on the failed run (or the test id).",
      );
    }
    const steps = repair.definition.steps;
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) {
      throw new BadRequestException(
        `Step ${stepIndex} is out of range — this test has ${steps.length} steps, so pass a stepIndex between 0 and ${steps.length - 1}.`,
      );
    }

    const old = s.page;
    const page = await s.context.newPage();
    s.page = page;
    await old.close().catch(() => undefined);
    const { reachedStep, brokeAt } = await this.driveTo(page, repair.definition, repair.profile, stepIndex);
    repair.stepIndex = stepIndex;
    repair.reachedStep = reachedStep;
    repair.brokeAt = brokeAt;
    this.log.log(`repair ${sessionId}: re-parked on step ${stepIndex} (reached ${reachedStep})`);
    return this.repairView(sessionId);
  }

  /**
   * Everything a repair session is currently looking at: the step it is parked on, why that step
   * is failing, and what the live page offers instead. Built from session state so
   * `open_repair_session` and `goto_step` describe the parked page the same way — a re-park must
   * not read differently from a fresh open.
   */
  private async repairView(sessionId: string): Promise<RepairSessionResult> {
    const s = this.require(sessionId);
    const repair = s.repair;
    if (!repair) throw new BadRequestException("Not a repair session.");
    const { definition, stepIndex, reachedStep, brokeAt, profile } = repair;
    const step = definition.steps[stepIndex];
    const recordedTarget = "target" in step ? step.target : undefined;
    // Resolve the recorded locator against the page as it is NOW — the actual answer to "why is
    // this step failing". Skipped when the drive never reached the step: the page would be the
    // wrong one, and a verdict against it would be noise dressed as a finding.
    const diagnosis =
      recordedTarget && !brokeAt
        ? await this.assess(
            s.page,
            profile ? resolveFingerprintTokens(recordedTarget, step, profile) : recordedTarget,
          )
        : null;

    const failedAt = repair.runFailedStepIndex;
    const reproduced = brokeAt ? brokeAt.index === failedAt : diagnosis?.status !== "resolved";
    const note = brokeAt
      ? brokeAt.index === failedAt
        ? `The drive failed at step ${brokeAt.index + 1} (${brokeAt.label}) — the same step the Run failed on. The page you are parked on is the state BEFORE that step.`
        : `The drive broke EARLIER than step ${stepIndex + 1}, at step ${brokeAt.index + 1} (${brokeAt.label}), so step ${stepIndex + 1} was never reached. Deal with step ${brokeAt.index + 1} first — call goto_step with stepIndex ${brokeAt.index}.`
      : diagnosis?.status === "resolved"
        ? `The recorded locator RESOLVES on this page, so the original failure did not reproduce. Either the page is in a different state than it was during the Run, or the failure is intermittent (a timing/late-render problem rather than a locator problem). Check the diagnosis verdict — a fragile locator that happens to resolve today is still the likely culprit.`
        : `Reproduced: the recorded locator does not resolve on this page. The diagnosis below says which way it fails.`;

    const { nodes } = await s.page.evaluate(collectSnapshot);
    await this.emitFrame(sessionId, { type: "navigate" });
    return {
      sessionId,
      mode: "repair",
      run: { id: repair.runId, error: repair.runError, failedStepIndex: failedAt },
      test: {
        id: repair.testId,
        name: repair.testName,
        version: repair.version,
        environment: repair.environmentName,
      },
      step: { index: stepIndex, of: definition.steps.length, label: describeStep(step), type: step.type },
      replay: { reachedStep, brokeAt, reproduced, note },
      recordedLocator: summarizeFingerprint(recordedTarget),
      diagnosis,
      url: s.page.url(),
      title: await s.page.title().catch(() => ""),
      nodes,
      screenshot: (await s.page.screenshot()).toString("base64"),
      guidance: modeGuidance("repair"),
    };
  }

  /**
   * Drive a definition's steps `[0..stepIndex)` on a page, with the same primitive a Run uses, and
   * report how far it got. A step that throws STOPS the drive — we park wherever we got to and say
   * so, because "the path broke three steps earlier" is a different diagnosis from "this locator is
   * wrong", and conflating them sends the reader to the wrong step.
   */
  private async driveTo(
    page: Page,
    definition: TestDefinition,
    profile: EnvironmentProfile | null,
    stepIndex: number,
  ): Promise<{ reachedStep: number; brokeAt: { index: number; label: string } | null }> {
    const defaultWaits = definition.defaults?.waitBefore ?? [];
    const resolvedDefaultWaits = profile ? resolveWaits(defaultWaits, profile) : defaultWaits;
    let reachedStep = 0;
    for (let i = 0; i < stepIndex; i++) {
      const raw = definition.steps[i];
      try {
        await performStepAction(page, profile ? resolveStep(raw, profile) : raw, resolvedDefaultWaits);
        reachedStep = i + 1;
      } catch {
        return { reachedStep, brokeAt: { index: i, label: describeStep(raw) } };
      }
    }
    return { reachedStep, brokeAt: null };
  }

  /**
   * Try one candidate locator for the step under repair, against the page this session is parked
   * on. The patch is merged onto the step's REAL fingerprint (every other captured signal is
   * preserved — a locator edit never collapses the bundle) and run through the same matcher a Run
   * uses, so a `resolved` + `deterministic` verdict here means it resolves at Run time.
   *
   * Cheap to repeat: the prefix was driven once when the session opened, so each candidate costs
   * one in-page scan rather than a whole replay. That is the point — iterate here, then report the
   * one edit that works.
   */
  async tryLocator(sessionId: string, patch: FingerprintPatch): Promise<TryLocatorResult> {
    const s = this.require(sessionId);
    const repair = s.repair;
    if (!repair) {
      throw new BadRequestException(
        "try_locator only works in a repair session — open one with open_repair_session on the failed run.",
      );
    }
    if (repair.brokeAt) {
      throw new BadRequestException(
        `This session is parked at step ${repair.brokeAt.index + 1} (${repair.brokeAt.label}), which broke before step ${repair.stepIndex + 1} was reached. A candidate for step ${repair.stepIndex + 1} cannot be judged from here — re-open the session with stepIndex ${repair.brokeAt.index} and fix that step first.`,
      );
    }
    const step = repair.definition.steps[repair.stepIndex];
    const base = "target" in step ? step.target : undefined;
    if (!base) throw new BadRequestException("The step under repair has no element locator to patch.");

    const candidate = applyFingerprintPatch(base, patch);
    if (!hasMatchableSignal(candidate)) {
      throw new BadRequestException(
        "That patch clears every distinguishing signal — the result could never resolve. Set at least one of testId / selectorOverride / role / accessibleName / text.",
      );
    }
    const resolved = repair.profile
      ? resolveFingerprintTokens(candidate, step, repair.profile)
      : candidate;
    const assessment = await this.assess(s.page, resolved);
    return {
      ok: true,
      stepIndex: repair.stepIndex,
      candidate: summarizeFingerprint(candidate),
      patch,
      // Worth proposing only when it both resolves AND wins on something durable — "it resolves"
      // is exactly the bar that let the current broken locator through in the first place.
      recommend:
        assessment.status === "resolved" &&
        (assessment.verdict === "deterministic" || assessment.verdict === "row-scoped"),
      ...assessment,
    };
  }

  /**
   * Write a verified fix onto the test — a new audited `test_version` with the patched locator.
   *
   * Two gates stand between a suggestion and the stored test, and neither is optional:
   *
   *  1. **It must work.** The candidate is re-verified against the parked page through the same
   *     matcher a Run uses, immediately before the write. A candidate that is `not-found` or
   *     `ambiguous` is refused outright — this can only ever replace a broken locator with one
   *     that demonstrably resolves, never with another guess.
   *  2. **It must be the same step.** The patch is applied to the test's LATEST version, which may
   *     have moved on since the Run failed. If the step at that index is no longer the step being
   *     repaired, the write is refused rather than silently landing on someone else's step.
   *
   * The write itself goes through `TestsService.saveConfig` — the exact path the web locator
   * editor uses — so an MCP-applied fix and a hand-applied one are the same operation, with the
   * same validation, the same optimistic-concurrency check, and the same audit trail. The prior
   * version is retained; this appends, it never overwrites.
   */
  async applyFix(sessionId: string, patch: FingerprintPatch): Promise<ApplyFixResult> {
    const s = this.require(sessionId);
    const repair = s.repair;
    if (!repair) {
      throw new BadRequestException(
        "apply_fix only works in a repair session — open one with open_repair_session on the failed run.",
      );
    }
    // Gate 1: prove it resolves, right now, against the page the step actually faces. `tryLocator`
    // re-runs the real matcher, so this is the same verdict the caller saw — not a stale one they
    // could have moved on from.
    const tried = await this.tryLocator(sessionId, patch);
    if (tried.status !== "resolved") {
      throw new BadRequestException(
        `Refusing to write this fix: it is ${tried.status} against the live page, so it would replace one broken locator with another. ${tried.advice}`,
      );
    }

    // Gate 2: the test may have changed since the run. Patch the LATEST version, and only if the
    // step at this index is still the one under repair.
    const [latest] = await this.db
      .select({ version: testVersions.version, definition: testVersions.definition })
      .from(testVersions)
      .where(eq(testVersions.testId, repair.testId))
      .orderBy(desc(testVersions.version))
      .limit(1);
    if (!latest) throw new NotFoundException(`Test ${repair.testId} not found`);
    const latestDef = latest.definition as TestDefinition;
    const target = latestDef.steps[repair.stepIndex];
    const expected = repair.definition.steps[repair.stepIndex];
    if (!target || describeStep(target) !== describeStep(expected)) {
      throw new BadRequestException(
        `The test has changed since this repair session opened: step ${repair.stepIndex + 1} is now "${target ? describeStep(target) : "gone"}", not "${describeStep(expected)}". Not writing — re-open the repair session so you are diagnosing the current test.`,
      );
    }

    const { version, versionId } = await this.tests.saveConfig(
      repair.testId,
      { baseVersion: latest.version, steps: [{ index: repair.stepIndex, target: patch }] },
      `${s.ownerEmail} (Claude repair)`,
      await this.reviewFor({ id: s.ownerId, kind: s.ownerKind }, repair.testId),
    );

    // Keep the session honest about what the test now says, so a second fix in the same session
    // patches the new state rather than the one that failed.
    const [written] = await this.db
      .select({ definition: testVersions.definition })
      .from(testVersions)
      .where(and(eq(testVersions.testId, repair.testId), eq(testVersions.version, version)))
      .limit(1);
    if (written) repair.definition = written.definition as TestDefinition;

    // A fix can resolve and still be built on something that will not last. Say so rather than
    // let "applied" read as "fixed for good".
    const warning = tried.recommend
      ? null
      : `Applied, but this locator matched on ${tried.matchedSignal ?? "a weak signal"} (${tried.verdict}) — ${tried.advice}`;
    this.log.log(
      `repair ${sessionId}: wrote v${version} of test ${repair.testId} (step ${repair.stepIndex}, ${tried.matchedSignal}) for ${s.ownerEmail}`,
    );
    return {
      ok: true,
      testId: repair.testId,
      stepIndex: repair.stepIndex,
      versionId,
      version,
      baseVersion: latest.version,
      patch,
      verdict: tried.verdict,
      matchedSignal: tried.matchedSignal,
      warning,
      summary: `Step ${repair.stepIndex + 1} of "${repair.testName}" now matches on ${tried.matchedSignal}. Saved as v${version} (was v${latest.version}); the previous version is retained.`,
    };
  }

  // ── editing the test itself (any step, any field) ──────────────────────────────────
  //
  // `applyFix` above is the NARROW path: one locator, verified against the live page before it is
  // written. It exists because that is the repair that must never be a guess. But a broken test is
  // not always a broken locator — the checkpoint asserts the wrong region, the typed value is
  // stale, a step is missing, a wait is needed, the checkpoint should be judged by an LLM rather
  // than pixel-diffed, two steps are in the wrong order. Those are ordinary edits, and refusing
  // them would send the user to the web editor mid-repair with the diagnosis in their head.
  //
  // So `readTest`/`editTest` expose the WHOLE editable definition, through the very same
  // `TestsService.saveConfig` seam the web editor writes through — same validation, same optimistic
  // lock, same audited new version, previous version retained. The difference from `applyFix` is
  // deliberate and worth stating plainly: a general edit is NOT verified against a live page. It
  // can write a locator that does not resolve, in the same way the web editor can.

  /** What one step looks like to the model: its index, its label, and every field that can be
   *  edited on it — so an edit can be addressed precisely instead of guessed at. */
  private toEditableStep(step: TestConfigStep): Record<string, unknown> {
    const screenshot = step.type === "screenshot";
    return {
      index: step.index,
      type: step.type,
      label: step.label,
      ...(step.url !== null ? { url: step.url } : {}),
      ...(step.value !== null ? { value: step.value } : {}),
      ...(screenshot
        ? {
            checkpointName: step.checkpointName,
            captureMode: step.captureMode,
            compareMode: step.compareMode,
            ...(step.prompt !== null ? { prompt: step.prompt } : {}),
            ...(step.threshold !== null ? { threshold: step.threshold } : {}),
            ...(step.rect ? { rect: step.rect } : {}),
            ...(step.masks.length ? { masks: step.masks } : {}),
            hasBaseline: step.baselineUrl !== null,
          }
        : {}),
      ...(step.waitBefore.length ? { waitBefore: step.waitBefore } : {}),
      ...(step.target ? { locator: step.target } : {}),
    };
  }

  /**
   * Read the test's CURRENT definition as an editable surface: every step, with its index and
   * every field an edit can address. The prerequisite for changing anything — an edit is keyed by
   * step index, and an index guessed from a run's error message is how you edit the wrong step.
   *
   * Always the LATEST version, not the one a failed run used: an edit lands on the latest, so this
   * has to describe what the edit will actually hit.
   */
  async readTest(input: { sessionId?: string; testId?: string }): Promise<{
    testId: string;
    name: string;
    version: number;
    notes: string | null;
    needsEnvironment: boolean;
    defaults: unknown[];
    steps: Record<string, unknown>[];
    /** The test's declared Assertions, each with its stable id and the pinned form it evaluates —
     *  what an assertion edit (a rewording, or the slice-10 target re-pin) is keyed off. */
    assertions: unknown[];
    /** Set in a repair session: which step the browser is currently parked on. */
    parkedOnStep?: number;
  }> {
    const testId = this.resolveTestId(input);
    const config = await this.tests.getConfig(testId);
    const parked = input.sessionId ? this.sessions.get(input.sessionId)?.repair?.stepIndex : undefined;
    return {
      testId: config.id,
      name: config.name,
      version: config.version,
      notes: config.notes,
      needsEnvironment: config.needsEnvironment,
      defaults: config.defaults,
      steps: config.steps.map((step) => this.toEditableStep(step)),
      assertions: config.assertions,
      ...(parked !== undefined ? { parkedOnStep: parked } : {}),
    };
  }

  /**
   * Apply an arbitrary edit to the test and write it as a new audited version.
   *
   * Everything the definition holds is reachable from here: per-step field edits (checkpoint name /
   * capture mode / compare mode / judge prompt / threshold / masks / region rect, the typed value,
   * a navigate URL, waits, the locator), step removal, step insertion, and reordering — plus the
   * test's name and notes, which live on the row rather than the definition and so are written
   * separately, without bumping a version.
   *
   * Two things it does that the web editor cannot:
   *  - `ref` — a step's locator can be RE-CAPTURED from the page the session is parked on, or an
   *    inserted click/hover/type/checkpoint can be built on a real captured fingerprint rather than
   *    a hand-written selector. That is the difference between a step that self-heals and a step
   *    hanging off one brittle CSS path.
   *  - `baseVersion` is resolved here rather than supplied. The model has no editor tab open to go
   *    stale, and making it guess a version number only invents 409s.
   */
  async editTest(input: TestEditInput): Promise<TestEditResult> {
    const testId = this.resolveTestId(input);
    const session = input.sessionId ? this.require(input.sessionId) : undefined;
    const config = await this.tests.getConfig(testId);
    const changes: string[] = [];

    // Name / notes live on the test ROW (organization metadata, like folder and tags), not in the
    // versioned definition — so they are written through the structural update and never bump a
    // version. Deferred until the definition patch has gone through: a rejected edit should leave
    // NOTHING applied, and a rename that survives a refusal is the confusing half-state.
    const rename = input.name?.trim();
    const renamesTest = rename !== undefined && rename !== "" && rename !== config.name;
    const applyRowEdits = async (): Promise<void> => {
      if (renamesTest) {
        await this.tests.update(testId, { name: rename }, session?.ownerEmail);
        changes.push(`renamed the test to "${rename}"`);
      }
      if (input.notes !== undefined) {
        await this.tests.update(testId, { notes: input.notes }, session?.ownerEmail);
        changes.push(input.notes.trim() ? "updated the test notes" : "cleared the test notes");
      }
    };

    const steps: TestConfigStepPatch[] = [];
    for (const edit of input.steps ?? []) {
      // Coerce the index: it arrives as raw JSON from an MCP client, and a string "2" would sail
      // through every check here and then silently match no step in `saveConfig`'s numeric map —
      // an edit that reports success and changes nothing is the worst outcome available.
      const index = Number(edit.index);
      const step = Number.isInteger(index) ? config.steps[index] : undefined;
      if (!step) {
        throw new BadRequestException(
          `There is no step ${edit.index} — this test has ${config.steps.length} steps (0..${config.steps.length - 1}). Call read_test and address the step by the index it reports.`,
        );
      }
      const label = `step ${index + 1} (${step.label})`;
      const patch: TestConfigStepPatch = { index };
      if (edit.remove) {
        patch.remove = true;
        changes.push(`removed ${label}`);
        steps.push(patch);
        continue;
      }
      if (edit.name !== undefined) {
        this.assertStepType(step, "screenshot", "renaming a checkpoint", index);
        patch.name = edit.name;
        changes.push(`renamed the checkpoint on ${label} to "${edit.name}"`);
      }
      if (edit.captureMode !== undefined) {
        this.assertStepType(step, "screenshot", "changing the capture mode", index);
        patch.captureMode = edit.captureMode;
        changes.push(`set ${label} to capture ${edit.captureMode}`);
      }
      if (edit.rect !== undefined) {
        this.assertStepType(step, "screenshot", "setting a region rect", index);
        patch.rect = edit.rect;
        changes.push(`set the region rect on ${label}`);
      }
      if (edit.compareMode !== undefined) {
        this.assertStepType(step, "screenshot", "changing the compare mode", index);
        patch.compareMode = edit.compareMode;
        changes.push(`set ${label} to compare by ${edit.compareMode}`);
      }
      if (edit.prompt !== undefined) {
        this.assertStepType(step, "screenshot", "setting a judge prompt", index);
        patch.prompt = edit.prompt;
        changes.push(edit.prompt.trim() ? `set the judge prompt on ${label}` : `cleared the judge prompt on ${label}`);
      }
      if (edit.threshold !== undefined) {
        this.assertStepType(step, "screenshot", "setting a threshold", index);
        patch.threshold = edit.threshold;
        changes.push(`set the threshold on ${label} to ${edit.threshold}`);
      }
      if (edit.masks !== undefined) {
        this.assertStepType(step, "screenshot", "setting masks", index);
        patch.masks = edit.masks;
        changes.push(edit.masks.length ? `set ${edit.masks.length} mask(s) on ${label}` : `cleared the masks on ${label}`);
      }
      if (edit.url !== undefined) {
        this.assertStepType(step, "navigate", "changing the URL", index);
        patch.url = edit.url;
        changes.push(`pointed ${label} at ${edit.url}`);
      }
      if (edit.value !== undefined) {
        this.assertStepType(step, "type", "changing the typed value", index);
        patch.value = edit.value;
        changes.push(`set the typed value on ${label}`);
      }
      if (edit.waitBefore !== undefined) {
        patch.waitBefore = edit.waitBefore;
        changes.push(edit.waitBefore.length ? `set ${edit.waitBefore.length} wait(s) before ${label}` : `cleared the waits before ${label}`);
      }
      if (edit.dropRecordedWaits !== undefined) {
        patch.dropLockedWaits = edit.dropRecordedWaits.map(Number);
        changes.push(`dropped ${patch.dropLockedWaits.length} recorded wait(s) before ${label}`);
      }
      if (edit.ref !== undefined) {
        if (!step.target) {
          throw new BadRequestException(
            `Step ${index + 1} (${step.label}) has no element locator to re-capture — only click, hover, type and element-mode checkpoints do.`,
          );
        }
        patch.recapture = (await this.captureRef(session, edit.ref, step.type !== "screenshot")) as unknown as Record<string, unknown>;
        changes.push(`re-captured the locator on ${label} from the live page`);
      }
      if (edit.locator !== undefined) {
        patch.target = edit.locator;
        changes.push(`edited the locator on ${label}`);
      }
      steps.push(patch);
    }

    const inserts: TestConfigPatch["inserts"] = [];
    for (const insert of input.inserts ?? []) {
      const atIndex = Number(insert.atIndex);
      if (!Number.isInteger(atIndex) || !config.steps[atIndex]) {
        throw new BadRequestException(
          `There is no step ${insert.atIndex} to anchor an insert to — this test has ${config.steps.length} steps (0..${config.steps.length - 1}).`,
        );
      }
      inserts.push({
        atIndex,
        position: insert.position === "above" ? "above" : "below",
        step: await this.buildInsertedStep(insert.step, session),
      });
      changes.push(`inserted a ${insert.step.type} step ${insert.position} step ${atIndex + 1}`);
    }

    // Assertion edits (slice 09), including the slice-10 re-pin. Validated against what the test
    // actually declares before anything is written, so an agent addressing an assertion that is not
    // there is told so rather than having its edit silently no-op.
    const assertions: TestConfigAssertionPatch[] = [];
    for (const edit of input.assertions ?? []) {
      const id = String(edit.id ?? "");
      const declared = config.assertions.find((a) => a.id === id);
      if (!declared) {
        throw new BadRequestException(
          config.assertions.length
            ? `This test declares no assertion "${id}". It declares: ${config.assertions.map((a) => `"${a.id}"`).join(", ")}. Call read_test and address the assertion by the id it reports.`
            : `This test declares no assertions at all, so there is no "${id}" to edit.`,
        );
      }
      const patch: TestConfigAssertionPatch = { id };
      if (edit.remove) {
        patch.remove = true;
        changes.push(`removed the assertion "${id}" ("${declared.check}")`);
        assertions.push(patch);
        continue;
      }
      if (edit.check !== undefined) {
        patch.check = edit.check;
        changes.push(`reworded the assertion "${id}"`);
      }
      for (const side of ["left", "right"] as const) {
        if (edit[side] === undefined) continue;
        patch[side] = edit[side];
        changes.push(`re-pinned the ${side}-hand target of the assertion "${id}"`);
      }
      assertions.push(patch);
    }

    if (input.order !== undefined) changes.push("reordered the steps");
    if (input.defaults !== undefined) {
      changes.push(input.defaults.length ? "set the test-level default waits" : "cleared the test-level default waits");
    }

    const patch: TestConfigPatch = {
      baseVersion: config.version,
      ...(input.defaults !== undefined ? { defaults: input.defaults } : {}),
      ...(steps.length ? { steps } : {}),
      ...(inserts.length ? { inserts } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      ...(assertions.length ? { assertions } : {}),
    };
    const touchesDefinition =
      patch.defaults !== undefined ||
      patch.steps !== undefined ||
      patch.inserts !== undefined ||
      patch.order !== undefined ||
      patch.assertions !== undefined;
    if (!touchesDefinition) {
      if (!renamesTest && input.notes === undefined) {
        throw new BadRequestException(
          "edit_test was given nothing to change. Pass `steps`, `inserts`, `order`, `defaults`, `assertions`, `name` or `notes` — call read_test first to see what is there.",
        );
      }
      // A name/notes-only edit is a row update; there is no new version to report.
      await applyRowEdits();
      const after = await this.tests.getConfig(testId);
      return {
        ok: true,
        testId,
        versionId: "",
        version: after.version,
        baseVersion: after.version,
        changes,
        steps: after.steps.map((step) => this.toEditableStep(step)),
        note: "Name/notes live on the test row, so no new test version was written.",
      };
    }

    const { version, versionId } = await this.tests.saveConfig(
      testId,
      patch,
      `${session?.ownerEmail ?? input.actor?.email ?? "mcp"} (Claude edit)`,
      await this.reviewFor(session ? { id: session.ownerId, kind: session.ownerKind } : input.actor, testId),
    );
    await applyRowEdits();

    // Keep a repair session honest about what the test now says: subsequent try_locator/apply_fix
    // calls must patch the definition as edited, not the one the session opened with. The parked
    // PAGE is still the old drive, though — say so rather than let a stale page read as verified.
    const after = await this.tests.getConfig(testId);
    const repair = session?.repair;
    if (repair && repair.testId === testId) {
      const [written] = await this.db
        .select({ definition: testVersions.definition })
        .from(testVersions)
        .where(and(eq(testVersions.testId, testId), eq(testVersions.version, version)))
        .limit(1);
      if (written) repair.definition = written.definition as TestDefinition;
      repair.version = version;
      repair.stepIndex = Math.min(repair.stepIndex, repair.definition.steps.length - 1);
    }
    this.log.log(
      `edit_test: wrote v${version} of test ${testId} (${changes.length} change(s)) for ${session?.ownerEmail ?? "mcp"}`,
    );
    return {
      ok: true,
      testId,
      versionId,
      version,
      baseVersion: config.version,
      changes,
      steps: after.steps.map((step) => this.toEditableStep(step)),
      note: repair
        ? `Saved as v${version} (v${config.version} is retained). The browser is still parked on the drive from BEFORE this edit — call goto_step to re-drive the edited test if you want to see or verify the change on the live page.`
        : `Saved as v${version}; v${config.version} is retained.`,
    };
  }

  /** Which test an edit addresses: the one named outright, else the one the session is repairing. */
  private resolveTestId(input: { sessionId?: string; testId?: string }): string {
    const explicit = input.testId?.trim();
    const repair = input.sessionId ? this.require(input.sessionId).repair : undefined;
    if (explicit && repair && repair.testId !== explicit) {
      throw new BadRequestException(
        `This session is repairing test ${repair.testId}, but you passed testId ${explicit}. Drop the testId to edit the test under repair, or drop the sessionId to edit a different test.`,
      );
    }
    const id = explicit || repair?.testId;
    if (!id) {
      throw new BadRequestException(
        "Pass a testId (the id in the test's web-app URL), or a sessionId from an open repair session to edit the test it is repairing.",
      );
    }
    return id;
  }

  /** Guard a field edit against the step type that actually carries it, before anything is
   *  written — "prompt on a click step" is a mistaken index far more often than a mistaken field. */
  private assertStepType(step: TestConfigStep, type: TestConfigStep["type"], what: string, index: number): void {
    if (step.type !== type) {
      throw new BadRequestException(
        `Step ${index + 1} is a ${step.type} step (${step.label}), and ${what} only applies to a ${type} step. Check the index against read_test.`,
      );
    }
  }

  /** Capture a fingerprint off the session's live page for a snapshot `ref` — the same capture an
   *  authoring action performs, so a step built here is indistinguishable from a recorded one. */
  private async captureRef(
    session: SessionState | undefined,
    ref: string,
    climb: boolean,
  ): Promise<Fingerprint> {
    if (!session) {
      throw new BadRequestException(
        "A `ref` names an element on a live page, so it needs an open session — pass the sessionId of the repair session you are parked in (or use `selector` instead).",
      );
    }
    return this.captureFp(session.page, this.resolveRef(session.page, ref), climb);
  }

  /** Turn an inserted-step request into the contract's `NewStepInput`, capturing a live
   *  fingerprint when the caller addressed the element by `ref`. */
  private async buildInsertedStep(
    step: TestEditInsertStep,
    session: SessionState | undefined,
  ): Promise<NewStepInput> {
    if (step.type === "navigate") return { type: "navigate", url: step.url ?? "" };
    if (step.type === "screenshot") {
      const captureMode = step.captureMode ?? "fullpage";
      return {
        type: "screenshot",
        name: step.name ?? "",
        captureMode,
        ...(step.rect ? { rect: step.rect } : {}),
        ...(step.selector ? { selector: step.selector } : {}),
        ...(captureMode === "element" && step.ref
          ? { target: (await this.captureRef(session, step.ref, false)) as unknown as Record<string, unknown> }
          : {}),
        ...(step.compareMode ? { compareMode: step.compareMode } : {}),
        ...(step.prompt ? { prompt: step.prompt } : {}),
        ...(step.threshold !== undefined ? { threshold: step.threshold } : {}),
        ...(step.masks ? { masks: step.masks } : {}),
      };
    }
    const target = step.ref
      ? ((await this.captureRef(session, step.ref, true)) as unknown as Record<string, unknown>)
      : undefined;
    const located = { ...(target ? { target } : {}), ...(step.selector ? { selector: step.selector } : {}) };
    if (step.type === "type") return { type: "type", ...located, value: step.value ?? "" };
    if (step.type === "hover") return { type: "hover", ...located };
    return { type: "click", ...located };
  }

  /** Perceive the current page: a ref-annotated node list (+ optional screenshot). */
  async observe(sessionId: string, opts?: { screenshot?: boolean }): Promise<SnapshotResult> {
    const s = this.require(sessionId);
    return this.snapshot(s, opts?.screenshot ?? false);
  }

  /** Click a target — by snapshot `ref` (preferred) or visible `text` (fallback for
   *  anything observe didn't tag). Captures the element's fingerprint, performs the click,
   *  and appends a click step. */
  async click(
    sessionId: string,
    target: { ref?: string; text?: string },
  ): Promise<ActionResult> {
    const s = this.require(sessionId);
    const locator = this.resolveTarget(s.page, target);
    const fpRaw = await this.captureFp(s.page, locator, true);
    await locator.click({ timeout: 10_000 });
    await s.page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);

    const hoverFirst = this.flushHover(s, target.ref);
    const step = this.withWaits(s, buildClick(fpRaw));
    s.rec.push(step);
    await this.emitFrame(sessionId, { type: "click" });
    return {
      ok: true,
      recorded: { type: "click", ...(hoverFirst ? { hoverFirst } : {}) },
      snapshot: await this.snapshot(s, false),
    };
  }

  /**
   * Hover a target (by ref or text) to reveal hover-only affordances (dropdown menus,
   * "Read more →"), then return a fresh snapshot so the revealed elements get refs.
   *
   * The hover becomes a recorded step ONLY if it turns out to be load-bearing — i.e. the next
   * click/type targets something this hover revealed. That mirrors the human recorder (which
   * emits a hover only for content the user then interacts with) and is what makes replay
   * re-open the menu before clicking into it. Exploratory hovers record nothing.
   */
  async hover(
    sessionId: string,
    target: { ref?: string; text?: string },
  ): Promise<{ ok: true; note: string; snapshot: SnapshotResult }> {
    const s = this.require(sessionId);
    const before = new Set((await s.page.evaluate(collectSnapshot)).nodes.map((n) => n.ref));
    const locator = this.resolveTarget(s.page, target);
    // Capture BEFORE hovering: the fingerprint of the trigger as it is when targeted, matching
    // what a click would record. Climb like a click does — you hover the icon, not the button.
    const fp = await this.captureFp(s.page, locator, true);
    await locator.hover({ timeout: 10_000 });
    await s.page.waitForTimeout(150);
    const snapshot = await this.snapshot(s, false);
    const revealedRefs = new Set(snapshot.nodes.map((n) => n.ref).filter((r) => !before.has(r)));
    s.pendingHover = { target: fp, revealedRefs };
    return {
      ok: true,
      note: revealedRefs.size
        ? `hovered — revealed ${revealedRefs.size} element(s). Acting on one of them records this hover, so replay re-opens it.`
        : "hovered — nothing new appeared, so this hover records nothing.",
      snapshot,
    };
  }

  /** Navigate directly to a URL mid-session (a deep link, or to recover when a control
   *  can't be reached by click). Records a navigate step with the origin parameterized to
   *  {{baseUrl}}, so replay reproduces it. */
  async navigate(sessionId: string, url: string): Promise<ActionResult> {
    const s = this.require(sessionId);
    const target = (url ?? "").trim();
    if (!target) throw new BadRequestException("url is required");
    try {
      await s.page.goto(target, { waitUntil: "domcontentloaded" });
    } catch (err) {
      throw new BadRequestException(`could not navigate to ${target}: ${(err as Error).message}`);
    }
    const href = s.page.url();
    s.rec.push(buildEntryNavigate(href, new URL(href).origin));
    await this.emitFrame(sessionId, { type: "navigate" });
    return { ok: true, recorded: { type: "navigate" }, snapshot: await this.snapshot(s, false) };
  }

  /** Type a value into a field by ref. The value is recorded literally — no variables/secrets. */
  async type(sessionId: string, ref: string, value: string): Promise<ActionResult> {
    const s = this.require(sessionId);
    const locator = this.resolveRef(s.page, ref);
    const fpRaw = await this.captureFp(s.page, locator, false);
    await locator.fill(value, { timeout: 10_000 });

    const hoverFirst = this.flushHover(s, ref);
    const step = this.withWaits(s, buildType(fpRaw, value));
    s.rec.push(step);
    await this.emitFrame(sessionId, { type: "type" });
    return {
      ok: true,
      recorded: {
        type: "type",
        value: step.type === "type" ? step.value : undefined,
        ...(hoverFirst ? { hoverFirst } : {}),
      },
      snapshot: await this.snapshot(s, false),
    };
  }

  /**
   * Dry-run the REPLAY matcher against a target before committing a step to the test.
   *
   * Authoring and replay locate elements two completely different ways: here the agent holds a
   * `ref` (an attribute Varys stamped on the live DOM, which always resolves); on replay the ref
   * is long gone and the step is re-found by scoring the captured fingerprint's signals. So a
   * step can be recorded perfectly and still be unrunnable — and today that only surfaces on the
   * next Run, by which point the draft is written. This probe closes that loop: it captures the
   * fingerprint exactly as the corresponding action would, then runs the REAL matcher
   * (`@varys/locator-engine`'s `verify`, the same code a Run uses) against the current page.
   *
   * Two distinct things come back, and both matter:
   *  - `status` — can the matcher find it AT ALL (`resolved` / `ambiguous` / `not-found`).
   *  - `verdict` — is the signal it won on DURABLE. A target the matcher resolves purely by
   *    bounding-box size or by volatile visible text resolves fine right now and breaks the
   *    moment the data or the layout shifts, so `resolved` alone is not the question to ask.
   *
   * Nothing is recorded and the page is not touched (beyond the matcher's own invisible marker
   * attribute), so this is safe to call before any action.
   */
  async verifyLocator(
    sessionId: string,
    ref: string,
    action: LocatorProbeAction = "click",
  ): Promise<LocatorProbeResult> {
    const s = this.require(sessionId);
    const locator = this.resolveRef(s.page, ref);
    // Climb exactly as the real action would: click/hover/type rise to the actionable control,
    // an element checkpoint frames the exact node. Probing a different element than the step
    // would capture would make the verdict a lie.
    const fp = await this.captureFp(s.page, locator, action !== "checkpoint");
    const assessment = await this.assess(s.page, fp);
    return {
      ok: true,
      ref,
      action,
      ...assessment,
      recorded: {
        tag: fp.tag,
        ...(fp.testId ? { testId: fp.testId } : {}),
        ...(fp.attributes?.id ? { id: fp.attributes.id } : {}),
        ...(fp.role ? { role: fp.role } : {}),
        ...(fp.accessibleName ? { accessibleName: fp.accessibleName } : {}),
        ...(fp.accessibleName ? { nameFromAttr: !!fp.nameFromAttr } : {}),
        ...(fp.scope ? { scope: fp.scope } : {}),
        ...(fp.stableClasses?.length ? { stableClasses: fp.stableClasses } : {}),
        ...(fp.boundingBox
          ? { size: { width: Math.round(fp.boundingBox.width), height: Math.round(fp.boundingBox.height) } }
          : {}),
      },
    };
  }

  /** Add a wait primitive — performed live now and recorded onto the next step's waitBefore. */
  async wait(sessionId: string, input: AgentWait): Promise<ActionResult> {
    const s = this.require(sessionId);
    let w: Wait;
    if (input.kind === "delay") {
      const ms = Math.max(0, Math.min(input.ms, 30_000));
      await s.page.waitForTimeout(ms);
      w = { kind: "delay", ms: input.ms };
    } else if (input.kind === "networkIdle") {
      await s.page.waitForLoadState("networkidle", { timeout: input.timeoutMs ?? 15_000 }).catch(() => undefined);
      w = { kind: "networkIdle", ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) };
    } else if (input.kind === "streamIdle") {
      // Performed live with the SAME in-page settle logic replay uses (shared via
      // `streamIdleExpression`), so the snapshot Claude sees next is the one replay will assert.
      await s.page.evaluate(streamIdleExpression(input)).catch(() => undefined);
      w = {
        kind: "streamIdle",
        ...(input.quietMs ? { quietMs: input.quietMs } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.busySelector?.trim() ? { busySelector: input.busySelector.trim() } : {}),
      };
    } else {
      const locator = this.resolveRef(s.page, input.ref);
      const fp = await this.captureFp(s.page, locator, false);
      await locator.waitFor({ state: input.state, timeout: input.timeoutMs ?? 15_000 }).catch(() => undefined);
      w = { kind: "selector", target: fp, state: input.state, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) };
    }
    s.pendingWaits.push(w);
    // A wait is not a step — it attaches to whatever is recorded next.
    return {
      ok: true,
      recorded: { type: "wait", wait: w.kind },
      snapshot: await this.snapshot(s, false),
    };
  }

  /** Propose a checkpoint (the visual assertion). element → captures the ref's fingerprint;
   *  region → a rect; fullpage → the whole page. Masks/threshold are best-effort proposals
   *  the human finalizes in review. Pending waits settle before the screenshot. */
  async checkpoint(sessionId: string, input: CheckpointInput): Promise<ActionResult> {
    const s = this.require(sessionId);
    if (s.repair) {
      throw new BadRequestException(
        "This is a repair session — the `checkpoint` tool records into a NEW draft, and there is no draft here. To add a checkpoint to the test under repair, use edit_test with an insert: { inserts: [{ atIndex, position, step: { type: \"screenshot\", name, captureMode } }] } — pass a `ref` from observe for an element checkpoint, and it is captured off this live page.",
      );
    }
    const name = (input.name ?? "").trim();
    if (!name) throw new BadRequestException("checkpoint name is required");
    const waits = s.pendingWaits;
    s.pendingWaits = [];
    const waitBefore = waits.length ? waits : undefined;
    const mode = input.mode ?? "element";

    // How it will be COMPARED — independent of how it is captured. `pixel` (the default) is an
    // exact diff and honours masks/threshold; `context` hands both screenshots to an LLM judge,
    // for content that is legitimately different every run (generated text, live figures).
    const compareMode = input.compareMode ?? "pixel";
    if (compareMode === "context" && (input.masks?.length || input.threshold !== undefined)) {
      throw new BadRequestException(
        "masks and threshold are pixel-mode knobs and are ignored by the context judge — drop them, or describe what to ignore in the prompt instead.",
      );
    }
    if (input.threshold !== undefined && !(input.threshold > 0 && input.threshold <= 1)) {
      throw new BadRequestException("threshold must be a mismatched-pixel ratio between 0 and 1");
    }
    const comparison = {
      compareMode,
      ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
      ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
    };

    // A checkpoint asserts what is on screen, so a hover that revealed any of it is
    // load-bearing and must be recorded FIRST (replay re-hovers, then captures). An element
    // checkpoint is matched precisely by ref; fullpage/region have no ref, so any reveal
    // counts — an extra hover is harmless on replay, a missing one silently captures the
    // un-revealed page.
    const hoverFirst = this.flushHover(s, input.ref, { anyReveal: mode !== "element" });

    // Record the step (for replay) AND grab a reference screenshot for the promote view.
    // No network-idle settle — capture the page exactly as it is right now.
    let preview: Buffer;
    if (mode === "fullpage") {
      s.rec.checkpoint(name, { mode: "fullpage", masks: input.masks, waitBefore, ...comparison });
      preview = await s.page.screenshot({ fullPage: true });
    } else if (mode === "region") {
      if (!input.rect) throw new BadRequestException("region checkpoint requires a rect (x, y, width, height)");
      s.rec.checkpoint(name, { mode: "region", rect: input.rect, masks: input.masks, waitBefore, ...comparison });
      preview = await s.page.screenshot({ clip: input.rect });
    } else {
      if (!input.ref) throw new BadRequestException("element checkpoint requires a ref");
      const locator = this.resolveRef(s.page, input.ref);
      const fp = await this.captureFp(s.page, locator, false);
      s.rec.checkpoint(name, { mode: "element", target: fp, masks: input.masks, waitBefore, ...comparison });
      preview = await locator.screenshot();
    }
    s.previews.set(name, preview);
    await this.emitFrame(sessionId, { type: "screenshot", checkpoint: name });
    return {
      ok: true,
      recorded: { type: "screenshot", checkpoint: name, ...(hoverFirst ? { hoverFirst } : {}) },
      snapshot: await this.snapshot(s, false),
    };
  }

  /**
   * End the session and persist the draft. Deterministic per-mode discipline: an INTERACTIVE
   * session may be finished ONLY on the user's explicit instruction — the caller passes
   * `confirm: true` to attest that, and the server refuses otherwise, so the model can never
   * wrap up an interactive session on its own. A BATCH session runs its plan to completion and
   * finishes freely (no confirm needed).
   */
  async finish(sessionId: string, opts?: { confirm?: boolean }): Promise<FinishResult> {
    const s = this.require(sessionId);
    if (s.repair) {
      throw new BadRequestException(
        `This is a repair session on run ${s.repair.runId} — there is no draft to save, and saving one would fork the test you are trying to fix. Edits here are written straight onto test ${s.repair.testId} by apply_fix / edit_test (each one a new audited version), so there is nothing left to finish: report what you changed, then call close_repair_session.`,
      );
    }
    if (s.mode === "interactive" && !opts?.confirm) {
      throw new BadRequestException(
        "This is an interactive session — it ends ONLY when the user explicitly tells you to finish or save it. Do not finish on your own. Once the user says so, call finish_session again with confirm: true.",
      );
    }
    const definition = s.rec.getDefinition(s.name, s.viewport);
    const checkpointCount = s.rec.checkpointCount();
    const previews = [...s.previews].map(([checkpointName, bytes]) => ({ checkpointName, bytes }));
    const { id, version } = await this.tests.createDraft(definition, {
      intent: s.intent,
      previews,
      createdBy: s.ownerEmail,
    });
    this.sessionEvents.next({ sessionId, testId: id, version, checkpointCount, name: s.name });
    await this.teardown(sessionId);
    this.log.log(`finished authoring session ${sessionId} → draft ${id} (v${version})`);
    return {
      testId: id,
      version,
      checkpointCount,
      warning:
        checkpointCount === 0
          ? "This draft has no checkpoints, so it asserts nothing yet. That's expected if the plan never asked for one — a human can add a checkpoint in review. Do NOT add a checkpoint just to clear this notice."
          : null,
    };
  }

  /**
   * Throw the session away WITHOUT persisting a draft: close the browser, keep nothing. The
   * counterpart to `finish` — needed because a session that went wrong (wrong app, wrong flow,
   * a dead end) otherwise had only one exit, which was to save it as a draft someone then has
   * to triage and discard by hand.
   */
  async discard(sessionId: string): Promise<{ ok: true; discarded: string }> {
    const s = this.require(sessionId);
    const repair = s.repair;
    const stepCount = s.rec.stepCount();
    await this.teardown(sessionId);
    this.log.log(
      repair
        ? `closed repair session ${sessionId} (run ${repair.runId}, step ${repair.stepIndex})`
        : `discarded authoring session ${sessionId} (${stepCount} recorded step(s) dropped)`,
    );
    return { ok: true, discarded: sessionId };
  }

  // ── live preview (Slice 15 — Author with AI) ────────────────────────────────────────

  /** Live authoring frames across all sessions; the live-preview controller filters by
   *  sessionId. Decoupled from the model's perception — frames are never sent to the model. */
  liveFrames$(): Observable<AuthoringFrame> {
    return this.liveFrames.asObservable();
  }

  /** Terminal authoring events (a Draft created on finish) — the web hands off to the review
   *  queue when authoring completes. */
  sessionEvents$(): Observable<AuthoringDraftEvent> {
    return this.sessionEvents.asObservable();
  }

  /**
   * Assert that `ownerId` owns `sessionId`, throwing the same not-found as an unknown id
   * (Slice 16). Called once per MCP tool call and before any live-preview read, so it is
   * the single choke point for cross-user access — and it deliberately does NOT
   * distinguish "someone else's session" from "no such session", so a caller can't probe
   * for other users' session ids.
   */
  assertOwner(sessionId: string, ownerId: string): void {
    this.requireOwned(sessionId, ownerId);
  }

  /** The latest frame for a session the caller owns, so a viewer subscribing mid-session
   *  paints immediately. Returns undefined for anyone else's session. */
  latestFrame(sessionId: string, ownerId: string): AuthoringFrame | undefined {
    const s = this.sessions.get(sessionId);
    return s?.ownerId === ownerId ? s.lastFrame : undefined;
  }

  /** The caller's OWN active Authoring Sessions, for the live-preview picker. */
  async listSessions(ownerId: string): Promise<AuthoringSessionSummary[]> {
    const out: AuthoringSessionSummary[] = [];
    for (const [sessionId, s] of this.sessions) {
      if (s.ownerId !== ownerId) continue;
      out.push({
        sessionId,
        name: s.name,
        intent: s.intent,
        mode: s.mode,
        url: s.page.url(),
        title: await s.page.title().catch(() => ""),
        stepCount: s.rec.stepCount(),
        checkpointCount: s.rec.checkpointCount(),
      });
    }
    return out;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────

  /**
   * Run the REAL replay matcher over one fingerprint against a live page and turn the outcome
   * into a durability verdict. The single place both probes go through, so an authoring-time
   * check and a post-failure diagnosis of the same locator cannot disagree.
   *
   * The poll is deliberately short: in both callers the page is already in the state the step
   * faces, so a confident match returns on the first scan and only a genuine miss spends the
   * budget.
   */
  private async assess(page: Page, fp: Fingerprint): Promise<LocatorAssessment> {
    const outcome = await verify(page as unknown as VerifyPage, fp, { timeoutMs: 2_000, intervalMs: 250 });
    const { verdict, advice } = locatorVerdict(fp, outcome);
    return {
      status: outcome.status,
      matchedSignal: outcome.matchedSignal,
      healed: outcome.healed,
      verdict,
      advice,
    };
  }

  /** Capture a fingerprint of the resolved element in-page, reusing `captureFingerprint`.
   *  Serialized via `new Function` with a `__name` shim — tsx/esbuild keepNames injects
   *  `__name(...)` calls into the function source that don't exist in the page otherwise. */
  private async captureFp(page: Page, locator: Locator, climb: boolean): Promise<Fingerprint> {
    const handle = await locator.elementHandle();
    if (!handle) {
      throw new BadRequestException("no element for that ref — the page changed; call observe again");
    }
    try {
      const src = captureFingerprint.toString();
      const body = `var __name = function (f) { return f; }; return (${src})(arg.el, arg.climb ? { climb: true } : undefined);`;
      const run = new Function("arg", body) as (arg: { el: unknown; climb: boolean }) => unknown;
      // page.evaluate's generics go "excessively deep" when the arg carries an element
      // handle + a zod-inferred return; cast to a minimal signature (the handle is still
      // resolved to the live element at runtime regardless of the static type).
      const evaluate = page.evaluate.bind(page) as unknown as (
        fn: (arg: { el: unknown; climb: boolean }) => unknown,
        arg: { el: unknown; climb: boolean },
      ) => Promise<unknown>;
      return (await evaluate(run, { el: handle, climb })) as Fingerprint;
    } finally {
      await handle.dispose();
    }
  }

  private async snapshot(s: SessionState, screenshot: boolean): Promise<SnapshotResult> {
    const { nodes } = await s.page.evaluate(collectSnapshot);
    const result: SnapshotResult = { url: s.page.url(), title: await s.page.title(), nodes };
    if (screenshot) result.screenshot = (await s.page.screenshot()).toString("base64");
    return result;
  }

  /** Capture a live-preview frame after a mutating tool and publish it. Best-effort: a failed
   *  screenshot is logged and swallowed so it can never disrupt the Authoring Session. This is a
   *  human-only channel (the web live-preview pane) — separate from what the model perceives. */
  private async emitFrame(sessionId: string, recorded: AuthoringFrame["recorded"]): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      const png = await s.page.screenshot();
      const frame: AuthoringFrame = {
        sessionId,
        seq: (s.frameSeq += 1),
        url: s.page.url(),
        title: await s.page.title().catch(() => ""),
        screenshot: `data:image/png;base64,${png.toString("base64")}`,
        recorded,
        stepCount: s.rec.stepCount(),
        checkpointCount: s.rec.checkpointCount(),
      };
      s.lastFrame = frame;
      this.liveFrames.next(frame);
    } catch (err) {
      this.log.warn(`live frame capture failed for ${sessionId}: ${(err as Error).message}`);
    }
  }

  /** Drain pending waits onto a freshly-built step's `waitBefore` (navigate has none). */
  private withWaits(s: SessionState, step: Step): Step {
    if (s.pendingWaits.length === 0 || step.type === "navigate") return step;
    const waits = s.pendingWaits;
    s.pendingWaits = [];
    return { ...step, waitBefore: [...(step.waitBefore ?? []), ...waits] } as Step;
  }

  /** Resolve an action target — a snapshot `ref` (preferred) or, as a fallback, visible
   *  `text` (`getByText`, first match) for anything observe didn't tag. */
  private resolveTarget(page: Page, target: { ref?: string; text?: string }): Locator {
    if (target.ref) return this.resolveRef(page, target.ref);
    const text = (target.text ?? "").trim();
    if (!text) throw new BadRequestException("provide a ref (from observe) or visible text to target");
    return page.getByText(text, { exact: false }).first();
  }

  /**
   * Decide the fate of a pending hover and, if it was load-bearing, push it as a step.
   * Returns whether it was recorded. Called immediately BEFORE the step it precedes, so the
   * hover lands ahead of it and replay re-opens the revealed content first.
   *
   * Load-bearing = the following step acts on something this hover revealed (`ref` in
   * `revealedRefs`), or — for a step with no ref, like a fullpage checkpoint — the hover
   * revealed anything at all. Either way the pending hover is consumed: a hover is only ever
   * offered to the step directly after it.
   */
  private flushHover(s: SessionState, ref: string | undefined, opts?: { anyReveal?: boolean }): boolean {
    const pending = s.pendingHover;
    s.pendingHover = undefined;
    if (!pending || !pending.revealedRefs.size) return false;
    const loadBearing = ref ? pending.revealedRefs.has(ref) : !!opts?.anyReveal;
    if (!loadBearing) return false;
    s.rec.push(this.withWaits(s, buildHover(pending.target)));
    return true;
  }

  private resolveRef(page: Page, ref: string): Locator {
    if (!ref || !/^e\d+$/.test(ref)) {
      throw new BadRequestException(`invalid ref "${ref}" — use a ref returned by observe/open`);
    }
    return page.locator(`[data-varys-ref="${ref}"]`);
  }

  /** Resolve a session AND mark it active — every tool goes through here, so this is the one
   *  place the idle clock is reset. */
  private require(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new NotFoundException(`Authoring session ${sessionId} not found or already finished`);
    s.lastActivityAt = Date.now();
    return s;
  }

  /** `require` plus an ownership check, collapsed into one indistinguishable not-found. */
  private requireOwned(sessionId: string, ownerId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s || s.ownerId !== ownerId) {
      throw new NotFoundException(`Authoring session ${sessionId} not found or already finished`);
    }
    return s;
  }

  /** Tear down sessions untouched for longer than `IDLE_TIMEOUT_MS`. */
  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [sessionId, s] of [...this.sessions]) {
      if (s.lastActivityAt > cutoff) continue;
      this.log.warn(
        `reaping idle authoring session ${sessionId} (${s.ownerEmail}, idle > ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m) — recorded steps are discarded`,
      );
      await this.teardown(sessionId);
    }
  }

  /** Close every live browser on shutdown, so a restart doesn't orphan Chromium processes. */
  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map((id) => this.teardown(id)));
  }

  private async teardown(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    await s.context.close().catch(() => undefined);
    await s.browser.close().catch(() => undefined);
  }
}
