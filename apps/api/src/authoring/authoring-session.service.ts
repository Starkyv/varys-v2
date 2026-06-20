import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { captureFingerprint } from "@varys/capture";
import {
  applySelectorRemedy,
  buildClick,
  buildEntryNavigate,
  buildType,
  createRecording,
  type KnownVariable,
  type Recording,
  selectorDependsOnVariable,
  type TypedKind,
} from "@varys/recorder";
import type { Fingerprint, Rect, Step, Viewport, Wait } from "@varys/step-schema";
import type {
  AuthoringDraftEvent,
  AuthoringFrame,
  AuthoringMode,
  AuthoringSessionSummary,
} from "@varys/review-contract";
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright-core";
import { type Observable, Subject } from "rxjs";
import { TestsService } from "../tests/tests.service";

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
  /** A terse record of what was appended to the test, for Claude's confirmation. */
  recorded: { type: Step["type"]; value?: string; checkpoint?: string };
  /** Set when the selector guard fired and a remedy was applied to the locator. */
  guard?: string;
  /** Fresh perception after the action, so Claude can decide the next step. */
  snapshot: SnapshotResult;
}

/** A wait the agent asks for: performed live now AND recorded onto the next step. */
export type AgentWait =
  | { kind: "delay"; ms: number }
  | { kind: "networkIdle"; timeoutMs?: number }
  | { kind: "selector"; ref: string; state: "visible" | "hidden"; timeoutMs?: number };

/** How to capture a checkpoint (Slice 4). element ⇒ a ref; region ⇒ a rect; fullpage ⇒ neither. */
export interface CheckpointInput {
  name: string;
  mode?: "element" | "fullpage" | "region";
  ref?: string;
  rect?: Rect;
  masks?: Rect[];
}

interface SessionState {
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
  /** Variables typed so far (name → authoring-time value) — the selector guard's reference. */
  knownVariables: KnownVariable[];
  /** Reference screenshots captured at each checkpoint (name → PNG) — the promote-view
   *  previews, persisted on finish. A Map so a re-checkpointed name keeps the latest. */
  previews: Map<string, Buffer>;
  /** Monotonic live-preview frame counter, and the latest frame so a viewer that subscribes
   *  mid-session paints immediately (Slice 15 — Author with AI). */
  frameSeq: number;
  lastFrame?: AuthoringFrame;
}

export interface OpenSessionInput {
  startUrl: string;
  name?: string;
  intent?: string;
  /** How Claude will drive this session (default "interactive"). See AuthoringMode. */
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
  return mode === "batch"
    ? "Batch mode: execute the whole plan to completion without pausing for confirmation between steps. Take a checkpoint ONLY where the plan explicitly asks for one (e.g. 'screenshot', 'capture', 'snapshot', 'checkpoint', 'verify this screen') — never add one on your own. When the plan is done, call finish_session."
    : "Step-by-step mode: perform ONLY the single action just requested, then stop and report what you did and what the page now shows. Do not run ahead to later steps. Take a checkpoint only when explicitly told to, and call finish_session only when the user says they're done.";
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
    if (tag === "input" || tag === "textarea" || tag === "select") {
      node.editable = true;
      node.value = (el as HTMLInputElement).value || "";
    }
    nodes.push(node);
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
export class AuthoringSessionService {
  private readonly log = new Logger(AuthoringSessionService.name);
  private readonly sessions = new Map<string, SessionState>();
  /** Live-preview frames across all sessions; the live-preview controller filters by sessionId.
   *  A human-only channel — these frames are never fed to the model. */
  private readonly liveFrames = new Subject<AuthoringFrame>();
  /** Terminal authoring events (a Draft created on finish), for the web review hand-off. */
  private readonly sessionEvents = new Subject<AuthoringDraftEvent>();

  constructor(@Inject(TestsService) private readonly tests: TestsService) {}

  async open(input: OpenSessionInput): Promise<OpenSessionResult> {
    const startUrl = (input.startUrl ?? "").trim();
    if (!startUrl) throw new BadRequestException("startUrl is required");
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
    const mode: AuthoringMode = input.mode === "batch" ? "batch" : "interactive";
    this.sessions.set(sessionId, {
      browser,
      context,
      page,
      rec,
      viewport,
      name: input.name?.trim() || "authored test",
      intent: input.intent?.trim() || null,
      mode,
      pendingWaits: [],
      knownVariables: [],
      previews: new Map(),
      frameSeq: 0,
    });
    this.log.log(`opened authoring session ${sessionId} on ${href} (${mode})`);
    const { nodes } = await page.evaluate(collectSnapshot);
    await this.emitFrame(sessionId, { type: "navigate" });
    return { sessionId, url: href, title: await page.title(), nodes, mode, guidance: modeGuidance(mode) };
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
    opts?: { remedy?: "bind" | "structural" },
  ): Promise<ActionResult> {
    const s = this.require(sessionId);
    const locator = this.resolveTarget(s.page, target);
    const fpRaw = await this.captureFp(s.page, locator, true);
    await locator.click({ timeout: 10_000 });
    await s.page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);

    const guard = this.applyGuard(s, fpRaw, opts?.remedy);
    const step = this.withWaits(s, buildClick(guard?.fp ?? fpRaw));
    s.rec.push(step);
    await this.emitFrame(sessionId, { type: "click" });
    return { ok: true, recorded: { type: "click" }, guard: guard?.note, snapshot: await this.snapshot(s, false) };
  }

  /** Hover a target (by ref or text) to reveal hover-only affordances (dropdown menus,
   *  "Read more →"), then return a fresh snapshot so the revealed elements get refs. A live
   *  authoring aid only — hovers are NOT recorded as steps (the step schema has none), so
   *  when a control only appears on hover, prefer clicking a stable container. */
  async hover(
    sessionId: string,
    target: { ref?: string; text?: string },
  ): Promise<{ ok: true; note: string; snapshot: SnapshotResult }> {
    const s = this.require(sessionId);
    await this.resolveTarget(s.page, target).hover({ timeout: 10_000 });
    await s.page.waitForTimeout(150);
    return {
      ok: true,
      note: "hovered (reveal only — hovers aren't recorded as steps)",
      snapshot: await this.snapshot(s, false),
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

  /** Type a value into a field by ref. The password→secret and variable/static policy is the
   *  shared `buildType` (Claude's declared `kind` wins, heuristic otherwise). The live value
   *  is filled to drive the app; the recorded step is tokenized — a password never persists. */
  async type(
    sessionId: string,
    ref: string,
    value: string,
    opts?: { kind?: TypedKind; name?: string; remedy?: "bind" | "structural" },
  ): Promise<ActionResult> {
    const s = this.require(sessionId);
    const locator = this.resolveRef(s.page, ref);
    const fpRaw = await this.captureFp(s.page, locator, false);
    const field = await locator
      .evaluate((node) => {
        const el = node as HTMLInputElement;
        return { type: el.type, id: el.id, name: el.name };
      })
      .catch(() => ({ type: undefined as string | undefined, id: "", name: "" }));
    await locator.fill(value, { timeout: 10_000 });

    const guard = this.applyGuard(s, fpRaw, opts?.remedy);
    const built = buildType(
      guard?.fp ?? fpRaw,
      { type: field.type, id: opts?.name || field.id, name: field.name, value },
      { kind: opts?.kind },
    );
    const step = this.withWaits(s, built);
    s.rec.push(step);
    this.trackVariable(s, step, value);
    await this.emitFrame(sessionId, { type: "type" });
    return {
      ok: true,
      recorded: { type: "type", value: step.type === "type" ? step.value : undefined },
      guard: guard?.note,
      snapshot: await this.snapshot(s, false),
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
    } else {
      const locator = this.resolveRef(s.page, input.ref);
      const fp = await this.captureFp(s.page, locator, false);
      await locator.waitFor({ state: input.state, timeout: input.timeoutMs ?? 15_000 }).catch(() => undefined);
      w = { kind: "selector", target: fp, state: input.state, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) };
    }
    s.pendingWaits.push(w);
    return { ok: true, recorded: { type: "type" }, snapshot: await this.snapshot(s, false) };
  }

  /** Propose a checkpoint (the visual assertion). element → captures the ref's fingerprint;
   *  region → a rect; fullpage → the whole page. Masks/threshold are best-effort proposals
   *  the human finalizes in review. Pending waits settle before the screenshot. */
  async checkpoint(sessionId: string, input: CheckpointInput): Promise<ActionResult> {
    const s = this.require(sessionId);
    const name = (input.name ?? "").trim();
    if (!name) throw new BadRequestException("checkpoint name is required");
    const waits = s.pendingWaits;
    s.pendingWaits = [];
    const waitBefore = waits.length ? waits : undefined;
    const mode = input.mode ?? "element";

    // Record the step (for replay) AND grab a reference screenshot for the promote view.
    // No network-idle settle — capture the page exactly as it is right now.
    let preview: Buffer;
    if (mode === "fullpage") {
      s.rec.checkpoint(name, { mode: "fullpage", masks: input.masks, waitBefore });
      preview = await s.page.screenshot({ fullPage: true });
    } else if (mode === "region") {
      if (!input.rect) throw new BadRequestException("region checkpoint requires a rect (x, y, width, height)");
      s.rec.checkpoint(name, { mode: "region", rect: input.rect, masks: input.masks, waitBefore });
      preview = await s.page.screenshot({ clip: input.rect });
    } else {
      if (!input.ref) throw new BadRequestException("element checkpoint requires a ref");
      const locator = this.resolveRef(s.page, input.ref);
      const fp = await this.captureFp(s.page, locator, false);
      s.rec.checkpoint(name, { mode: "element", target: fp, masks: input.masks, waitBefore });
      preview = await locator.screenshot();
    }
    s.previews.set(name, preview);
    await this.emitFrame(sessionId, { type: "screenshot", checkpoint: name });
    return { ok: true, recorded: { type: "screenshot", checkpoint: name }, snapshot: await this.snapshot(s, false) };
  }

  async finish(sessionId: string): Promise<FinishResult> {
    const s = this.require(sessionId);
    const definition = s.rec.getDefinition(s.name, s.viewport);
    const checkpointCount = s.rec.checkpointCount();
    const previews = [...s.previews].map(([checkpointName, bytes]) => ({ checkpointName, bytes }));
    const { id, version } = await this.tests.createDraft(definition, { intent: s.intent, previews });
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

  async abort(sessionId: string): Promise<{ ok: true }> {
    await this.teardown(sessionId);
    return { ok: true };
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

  /** The latest frame for a session, so a viewer subscribing mid-session paints immediately. */
  latestFrame(sessionId: string): AuthoringFrame | undefined {
    return this.sessions.get(sessionId)?.lastFrame;
  }

  /** Active Authoring Sessions, for the live-preview picker. */
  async listSessions(): Promise<AuthoringSessionSummary[]> {
    const out: AuthoringSessionSummary[] = [];
    for (const [sessionId, s] of this.sessions) {
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

  /** Selector guard: if the locator leans on env-specific visible text (matching a typed
   *  variable's value), apply Claude's remedy (default `structural`) so it stays portable. */
  private applyGuard(
    s: SessionState,
    fp: Fingerprint,
    remedy?: "bind" | "structural",
  ): { fp: Fingerprint; note: string } | undefined {
    const hit = selectorDependsOnVariable(fp, s.knownVariables);
    if (!hit) return undefined;
    const chosen = remedy ?? "structural";
    return {
      fp: applySelectorRemedy(fp, chosen, hit),
      note: `locator depended on env-specific ${hit.signal} "${hit.value}" (variable {{${hit.variable}}}); applied ${chosen} remedy`,
    };
  }

  /** Record a typed data variable's authoring-time value, for the selector guard. */
  private trackVariable(s: SessionState, step: Step, original: string): void {
    if (step.type !== "type") return;
    const m = /^\{\{([\w.-]+)\}\}$/.exec(step.value);
    if (m && m[1] !== "baseUrl") s.knownVariables.push({ name: m[1], value: original });
  }

  /** Resolve an action target — a snapshot `ref` (preferred) or, as a fallback, visible
   *  `text` (`getByText`, first match) for anything observe didn't tag. */
  private resolveTarget(page: Page, target: { ref?: string; text?: string }): Locator {
    if (target.ref) return this.resolveRef(page, target.ref);
    const text = (target.text ?? "").trim();
    if (!text) throw new BadRequestException("provide a ref (from observe) or visible text to target");
    return page.getByText(text, { exact: false }).first();
  }

  private resolveRef(page: Page, ref: string): Locator {
    if (!ref || !/^e\d+$/.test(ref)) {
      throw new BadRequestException(`invalid ref "${ref}" — use a ref returned by observe/open`);
    }
    return page.locator(`[data-varys-ref="${ref}"]`);
  }

  private require(sessionId: string): SessionState {
    const s = this.sessions.get(sessionId);
    if (!s) throw new NotFoundException(`Authoring session ${sessionId} not found or already finished`);
    return s;
  }

  private async teardown(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    await s.context.close().catch(() => undefined);
    await s.browser.close().catch(() => undefined);
  }
}
