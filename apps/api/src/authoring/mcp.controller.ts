import type { IncomingHttpHeaders } from "node:http";
import { Body, Controller, Get, Headers, HttpException, Inject, Post, Res } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { AuthoringInstructionsService } from "./authoring-instructions.service";
import { AuthoringSessionService, type CheckpointInput } from "./authoring-session.service";
import { McpAuthService, type McpPrincipal, McpUnauthorized } from "./mcp-auth.service";
import { McpStatusService } from "./mcp-status.service";

/** The slice of the HTTP response we touch — avoids depending on express types directly
 *  (it's only available transitively via @nestjs/platform-express). */
interface HttpRes {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/**
 * The Varys authoring MCP server — a minimal JSON-RPC 2.0 endpoint over Streamable
 * HTTP (JSON-response mode) that Claude Code connects to at `/mcp`. It exposes the
 * authoring session as MCP tools that delegate to `AuthoringSessionService`; the same
 * tools are what a deterministic test drives (no LLM).
 *
 * Authentication (Slice 16): every request must carry an OAuth 2.1 bearer token issued by
 * better-auth's `mcp` plugin, which resolves to the Varys user who authorized this Claude
 * Code install. That identity scopes everything the connection can see or drive —
 * authoring sessions and the "Claude Code active" indicator are per-user, not global.
 *
 * Hand-rolled rather than via `@modelcontextprotocol/sdk` deliberately: the SDK ships
 * ESM/CJS under a package `exports` map that the API's `moduleResolution: "node"`
 * (classic) can't resolve, and widening it API-wide is riskier than the tiny protocol
 * surface implemented here (initialize / tools.list / tools.call / ping).
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "varys-authoring", version: "0.1.0" };

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A registered MCP tool: name + JSON-Schema input + a handler over the service. */
interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

class MethodNotFound extends Error {}

// `@Public()` exempts this route from the COOKIE guard only — Claude Code is a separate
// process with no browser cookie. It is not unauthenticated: `rpc` below requires an OAuth
// bearer token on every request and 401s without one (Slice 16, superseding the earlier
// anonymous-MCP decision in DESIGN §11).
@Public()
@Controller("mcp")
export class McpController {
  constructor(
    @Inject(AuthoringSessionService) private readonly authoring: AuthoringSessionService,
    @Inject(McpStatusService) private readonly mcpStatus: McpStatusService,
    @Inject(McpAuthService) private readonly mcpAuth: McpAuthService,
    @Inject(AuthoringInstructionsService) private readonly instructions: AuthoringInstructionsService,
  ) {}

  // Streamable HTTP: this server doesn't push, so the optional server→client SSE stream
  // (opened via GET) is unsupported — clients fall back to POST/JSON.
  @Get()
  getStream(): never {
    throw new HttpException("Method Not Allowed", 405);
  }

  @Post()
  async rpc(
    @Body() body: JsonRpcMessage | JsonRpcMessage[],
    @Headers() headers: IncomingHttpHeaders,
    @Res({ passthrough: true }) res: HttpRes,
  ): Promise<unknown> {
    // Authenticate BEFORE anything else — including before touching the status service, so
    // an unauthenticated caller can't light up someone's "Claude Code active" indicator.
    let user: McpPrincipal;
    try {
      user = await this.mcpAuth.principal(headers);
    } catch (err) {
      if (!(err instanceof McpUnauthorized)) throw err;
      return this.unauthorized(body, res);
    }

    this.mcpStatus.touch(user.id); // record activity so THIS user's web app shows "active"
    let result: unknown;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.handle(m, user)))).filter(
        (r): r is JsonRpcResponse => r !== undefined,
      );
      result = out.length ? out : undefined;
    } else {
      result = await this.handle(body, user);
    }
    // Streamable HTTP: a POST carrying only notifications/responses (nothing to answer)
    // gets 202 Accepted with no body; a request gets its JSON-RPC response with 200.
    res.status(result === undefined ? 202 : 200);
    return result;
  }

  /**
   * The 401 that BOOTSTRAPS the OAuth flow. `WWW-Authenticate` points at the
   * protected-resource metadata, which is how Claude Code discovers the authorization
   * server, registers itself, and opens the browser — so this response is the feature, not
   * just an error. The body is a JSON-RPC error too, for clients that read it instead.
   */
  private unauthorized(body: JsonRpcMessage | JsonRpcMessage[], res: HttpRes): unknown {
    const challenge = this.mcpAuth.challenge();
    res.setHeader("WWW-Authenticate", challenge);
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
    res.status(401);
    const first = Array.isArray(body) ? body[0] : body;
    return {
      jsonrpc: "2.0",
      id: first?.id ?? null,
      error: {
        code: -32000,
        message: "Unauthorized: sign in to Varys to use the authoring MCP server",
        "www-authenticate": challenge,
      },
    };
  }

  private async handle(
    msg: JsonRpcMessage,
    user: McpPrincipal,
  ): Promise<JsonRpcResponse | undefined> {
    const id = msg?.id ?? null;
    const isNotification = msg?.id === undefined || msg?.id === null;
    try {
      const result = await this.dispatch(msg?.method, msg?.params ?? {}, user);
      return isNotification ? undefined : { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (isNotification) return undefined;
      const code = err instanceof MethodNotFound ? -32601 : -32603;
      return { jsonrpc: "2.0", id, error: { code, message: (err as Error).message } };
    }
  }

  private async dispatch(
    method: string | undefined,
    params: Record<string, unknown>,
    user: McpPrincipal,
  ): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        return {
          protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          // General authoring guidance the client folds into the model's context (the
          // "middleware prompt"). Editable from the Author page (DB-backed) and resolved per
          // connect, so a change takes effect on the next connect with no restart.
          instructions: await this.instructions.resolve(),
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined; // notifications carry no id → no response anyway
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: this.tools(user).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
      case "tools/call":
        return this.callTool(params, user);
      default:
        throw new MethodNotFound(`Method not found: ${method}`);
    }
  }

  /** Run a tool; tool-execution failures surface as an `isError` result (not a JSON-RPC
   *  error), per the MCP spec, so Claude sees the message and can recover. */
  private async callTool(params: Record<string, unknown>, user: McpPrincipal): Promise<unknown> {
    const name = params.name as string | undefined;
    const tool = this.tools(user).find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    const args = (params.arguments as Record<string, unknown>) ?? {};
    try {
      // The single cross-user choke point: every tool but `open_session` addresses an
      // existing session by id, so verifying ownership once here covers all of them —
      // a session id leaked or guessed from another user resolves as not-found.
      if (args.sessionId !== undefined) {
        this.authoring.assertOwner(String(args.sessionId), user.id);
      }
      const result = await tool.handler(args);
      // Surface a screenshot (`observe` with screenshot=true) as a viewable MCP image block
      // so Claude can SEE the page — e.g. to compare it against a reference design you gave
      // it — with the rest of the snapshot as JSON text. Other results are a text block.
      if (
        result &&
        typeof result === "object" &&
        typeof (result as { screenshot?: unknown }).screenshot === "string"
      ) {
        const { screenshot, ...rest } = result as { screenshot: string } & Record<string, unknown>;
        return {
          content: [
            { type: "text", text: JSON.stringify(rest) },
            { type: "image", data: screenshot, mimeType: "image/png" },
          ],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  }

  /** The MCP tool surface. Slice 2 = open/finish; Slices 3/4 add perception, interaction,
   *  and checkpoint tools to this list. Promotion is deliberately NOT a tool (web-UI only;
   *  Claude must not be able to self-promote — ADR 0001 / PRD safety). */
  private tools(user: McpPrincipal): McpTool[] {
    const a = this.authoring;
    return [
      {
        name: "open_session",
        description:
          "Open a Varys authoring session: launch a browser, navigate to the start URL, and begin recording. Returns a sessionId used by every later tool, plus the session `mode` and mode-specific `guidance` — read the guidance and follow it for the rest of the session. The entry URL's origin becomes {{baseUrl}} so the test stays environment-agnostic.",
        inputSchema: {
          type: "object",
          properties: {
            startUrl: { type: "string", description: "The URL to open the session on (e.g. the app's login page)." },
            name: { type: "string", description: "A name for the test being authored." },
            intent: { type: "string", description: "What this test should verify — the steering instruction (shown in the review queue)." },
            mode: {
              type: "string",
              enum: ["interactive", "batch"],
              description:
                "REQUIRED — how you'll drive this session; there is no default, so you must set it. Rule: use 'batch' ONLY when the user explicitly says 'batch' or points you at a plan/instructions file to run; use 'interactive' when the user is directing you one step at a time. Do NOT guess — if it is genuinely unclear which the user wants, ask them before opening the session. 'interactive': the user gives one instruction at a time — do that one action, then stop and wait; NEVER finish on your own — the session ends only when the user explicitly tells you to, and then you call finish_session with confirm: true. 'batch': run the whole plan/file end-to-end without pausing, then call finish_session. In BOTH modes, checkpoint only when explicitly asked.",
            },
          },
          required: ["startUrl", "mode"],
        },
        handler: (args) =>
          a.open({
            // Ownership comes from the bearer token, never from tool arguments — the model
            // has no way to open a session as somebody else.
            owner: { id: user.id, email: user.email },
            startUrl: String(args.startUrl ?? ""),
            name: args.name ? String(args.name) : undefined,
            intent: args.intent ? String(args.intent) : undefined,
            mode: args.mode === "batch" ? "batch" : args.mode === "interactive" ? "interactive" : undefined,
          }),
      },
      {
        name: "observe",
        description:
          "Perceive the current page: a list of interactive/landmark elements, each with a stable `ref`, role, name, and (for fields) value. Target later actions by `ref`. Nodes also carry the signals that decide whether a step can be RE-LOCATED on replay: `testId` (the element's data-testid — the strongest signal by far), `id` (only when author-stable; generated ids are omitted), and `duplicate: true` when another node shares this one's role+name with nothing to tell them apart — acting on a duplicate records a step that hard-fails on replay as ambiguous. Prefer targets with a `testId` or `id`; treat a blank `name` with no `testId`/`id` as unaddressable, and a `duplicate` as needing disambiguation. Use verify_locator when you want the matcher\'s actual verdict on a target. Set screenshot=true to also get a base64 PNG for visual disambiguation. This screenshot is for YOUR perception only — it is NOT a checkpoint and records nothing in the test; if the user asks you to take or capture a screenshot, use the checkpoint tool instead.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            screenshot: { type: "boolean", description: "Include a base64 PNG screenshot of the page." },
          },
          required: ["sessionId"],
        },
        handler: (args) => a.observe(String(args.sessionId ?? ""), { screenshot: Boolean(args.screenshot) }),
      },
      {
        name: "click",
        description:
          "Click an element — by `ref` from a snapshot (preferred), or by visible `text` as a fallback for anything observe didn't tag. Note: observe surfaces clickable cards/tiles (React onClick <div>s with cursor:pointer) as refs with role 'button', so prefer their ref. Captures the element's durable fingerprint, performs the click, records a click step, and returns a fresh snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            ref: { type: "string", description: "An element ref from a snapshot (e.g. e7)." },
            text: { type: "string", description: "Fallback: visible text to locate the element when it has no ref." },
          },
          required: ["sessionId"],
        },
        handler: (args) =>
          a.click(String(args.sessionId ?? ""), {
            ref: args.ref ? String(args.ref) : undefined,
            text: args.text ? String(args.text) : undefined,
          }),
      },
      {
        name: "hover",
        description:
          "Hover an element (by ref or text) to reveal hover-only affordances (dropdown menus, a 'Read more →' link), then get a fresh snapshot so the revealed elements get refs. The hover is recorded as a step ONLY if your next action targets something it revealed — which is exactly what makes replay re-open the menu before clicking into it. So: to click an item inside a hover menu, hover the trigger and then click the item; do NOT try to click the item directly, and do not worry about hovering to explore (an exploratory hover records nothing).",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            ref: { type: "string" },
            text: { type: "string" },
          },
          required: ["sessionId"],
        },
        handler: (args) =>
          a.hover(String(args.sessionId ?? ""), {
            ref: args.ref ? String(args.ref) : undefined,
            text: args.text ? String(args.text) : undefined,
          }),
      },
      {
        name: "navigate",
        description:
          "Navigate directly to a URL within the open session — a deep link, or to recover when a control can't be reached by clicking. Records a navigate step (origin → {{baseUrl}}). Returns a fresh snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            url: { type: "string", description: "The URL to navigate to." },
          },
          required: ["sessionId", "url"],
        },
        handler: (args) => a.navigate(String(args.sessionId ?? ""), String(args.url ?? "")),
      },
      {
        name: "type",
        description:
          "Type a value into the field with the given ref. The value is recorded literally (there are no variables or secrets — everything is a literal on the test). Only the entry URL's origin is parameterized, as {{baseUrl}}.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            ref: { type: "string" },
            value: { type: "string", description: "The value to type (recorded literally)." },
          },
          required: ["sessionId", "ref", "value"],
        },
        handler: (args) =>
          a.type(String(args.sessionId ?? ""), String(args.ref ?? ""), String(args.value ?? "")),
      },
      {
        name: "failed_runs",
        description:
          "List recent FAILED runs — run id, test, when it failed, which step, and the error. The starting point for repairing a broken test: pick the run, then open_repair_session on it. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            testId: { type: "string", description: "Optional: only this test's failures (the id in the test's web-app URL)." },
            testName: { type: "string", description: "Optional: only runs whose test name contains this (case-insensitive)." },
            limit: { type: "number", description: "How many to return (default 10, max 50)." },
          },
        },
        handler: (args) =>
          a.recentFailures({
            testId: args.testId ? String(args.testId) : undefined,
            testName: args.testName ? String(args.testName) : undefined,
            limit: args.limit !== undefined ? Number(args.limit) : undefined,
          }),
      },
      {
        name: "open_repair_session",
        description:
          "Diagnose a failed test by re-driving it yourself. Takes either a `runId` (a specific failure) or a `testId` (that test's most recent failure — use this when the user names a test rather than a run). Launches a browser, seeds the run's environment, replays the test's OWN steps (the exact version that ran, with the same drive a Run uses) up to the step that failed, and PARKS there — so the page the failing step faced is live in front of you. Returns why it failed: the run's error, what the recorded locator was looking for (`recordedLocator`), the matcher's verdict on that locator against the page as it is now (`diagnosis`), every element actually on the page (`nodes`, with testId/id/duplicate flags), and a screenshot. Then investigate with observe/hover, and test fixes with try_locator. IMPORTANT: a repair session records no new test — checkpoint and finish_session are refused. What it CAN do is fix the existing one: once try_locator confirms a candidate, apply_fix writes it to the test as a new version. Always verify with try_locator before applying, and always tell the user what you changed and the new version number. Read `replay.note` first — if the drive broke EARLIER than the run did, the step you were sent to was never reached and you must diagnose the earlier step instead (re-open with that stepIndex). Close with close_repair_session when done.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string", description: "The failed run to diagnose (from failed_runs, or the run's URL in the web app)." },
            testId: {
              type: "string",
              description:
                "Instead of a runId: diagnose this test's MOST RECENT failure. Use this when the user names a test or gives a test id (the id in the test's web-app URL) rather than a specific run. runId wins if both are given.",
            },
            stepIndex: {
              type: "number",
              description:
                "Optional 0-based step to park on. Defaults to the run's own failedStepIndex — override it to diagnose an earlier step, which is exactly what `replay.note` tells you to do when the path broke upstream.",
            },
          },
        },
        handler: (args) =>
          a.openRepair({
            owner: { id: user.id, email: user.email },
            runId: args.runId ? String(args.runId) : undefined,
            testId: args.testId ? String(args.testId) : undefined,
            stepIndex: args.stepIndex !== undefined ? Number(args.stepIndex) : undefined,
          }),
      },
      {
        name: "try_locator",
        description:
          "Test a candidate fix for the step under repair, against the parked page. Your patch is merged onto the step's REAL recorded fingerprint — every other captured signal is preserved, so this is the same edit the locator editor would make — and run through the same matcher a Run uses. A `resolved` + `deterministic` verdict means it would resolve at replay. Cheap to repeat: the replay prefix was driven once when the session opened, so each candidate costs one page scan, not a whole re-run. Iterate until `recommend` is true, then write THAT patch with apply_fix. Fields: set one to that value, pass an empty string to clear it. `testId` and `selectorOverride` are the strong fixes; `accessibleName`/`text`/`role` correct a locator whose recorded copy went stale.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            testId: { type: "string", description: "Set the target's data-testid (strongest signal)." },
            selectorOverride: {
              type: "string",
              description:
                "A raw CSS/Playwright selector tried FIRST and used as-is when it matches exactly one element. The escape hatch when no captured signal survives — but prefer a testId, which self-heals; an override that goes stale is simply ignored.",
            },
            role: { type: "string", description: "Set the expected ARIA role." },
            accessibleName: { type: "string", description: "Set the expected accessible name." },
            text: { type: "string", description: "Set the expected visible text." },
          },
          required: ["sessionId"],
        },
        handler: (args) => {
          const patch: Record<string, string> = {};
          for (const key of ["role", "accessibleName", "text", "testId", "selectorOverride"] as const) {
            if (args[key] !== undefined) patch[key] = String(args[key]);
          }
          if (Object.keys(patch).length === 0) {
            throw new Error(
              "try_locator needs at least one field to change (testId, selectorOverride, role, accessibleName, or text). Pass an empty string to CLEAR a field.",
            );
          }
          return a.tryLocator(String(args.sessionId ?? ""), patch);
        },
      },
      {
        name: "apply_fix",
        description:
          "WRITE the fix onto the test. Applies your locator patch to the step under repair and saves it as a new test version — the same operation, validation and audit trail as editing it by hand in the web app. Two things are enforced before anything is written: the candidate is re-verified against the live page (a patch that is not-found or ambiguous is REFUSED — this can only ever replace a broken locator with one that demonstrably resolves), and the step at that index must still be the step you diagnosed (if the test changed since the session opened, the write is refused rather than landing on the wrong step). The previous version is retained, so this appends rather than overwrites. Use try_locator to find the right patch FIRST — apply the one that came back `recommend: true`. A patch that resolves on a weak signal is still written, but comes back with a `warning`: report that caveat instead of declaring the test fixed. Tell the user the new version number afterwards.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            testId: { type: "string", description: "Set the target's data-testid (strongest, self-healing)." },
            selectorOverride: { type: "string", description: "Set a raw CSS/Playwright selector, used as-is when unique." },
            role: { type: "string", description: "Set the expected ARIA role." },
            accessibleName: { type: "string", description: "Set the expected accessible name." },
            text: { type: "string", description: "Set the expected visible text." },
          },
          required: ["sessionId"],
        },
        handler: (args) => {
          const patch: Record<string, string> = {};
          for (const key of ["role", "accessibleName", "text", "testId", "selectorOverride"] as const) {
            if (args[key] !== undefined) patch[key] = String(args[key]);
          }
          if (Object.keys(patch).length === 0) {
            throw new Error(
              "apply_fix needs at least one field to change (testId, selectorOverride, role, accessibleName, or text). Pass an empty string to CLEAR a field.",
            );
          }
          return a.applyFix(String(args.sessionId ?? ""), patch);
        },
      },
      {
        name: "close_repair_session",
        description:
          "Close a repair session and shut its browser down. Nothing is lost — a repair session never recorded anything. Call it once you have reported the diagnosis.",
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string" } },
          required: ["sessionId"],
        },
        handler: (args) => a.discard(String(args.sessionId ?? "")),
      },
      {
        name: "verify_locator",
        description:
          "Dry-run the REPLAY matcher against a target BEFORE you act on it, and read the verdict. Costs one call and prevents the most common way an AI-authored test dies: a step that records fine and then cannot be re-located on the next run. You hold a `ref`, which is an attribute Varys stamped on the live page — it always resolves. Replay has no refs: it re-finds the element by scoring the fingerprint's signals (data-testid > stable id > role+accessible name > row scope > name > classes > bounding-box size), and it refuses to act when nothing carries real identity or when two elements tie. This tool captures the fingerprint exactly as the action would, runs that same matcher, and returns: `status` (resolved | ambiguous | not-found), `matchedSignal`, `verdict` (deterministic | row-scoped | text-bound | fragile | ambiguous | not-found), one line of `advice`, and `recorded` — the signals the step would actually carry. Note `status: \"resolved\"` is NOT the question: a `fragile` verdict resolves right now and breaks the moment the data or layout shifts. Record the step when the verdict is `deterministic`; check the echoed text is stable UI copy (not data) when it is `row-scoped` or `text-bound`; pick a different target when it is `fragile`, `ambiguous`, or `not-found`. Nothing is recorded and the page is unchanged, so this is always safe to call.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            ref: { type: "string", description: "The element ref (from observe) you are about to act on." },
            action: {
              type: "string",
              enum: ["click", "type", "checkpoint"],
              description:
                "Which action you intend, so the probe captures the same element that action would: click/type rise to the actionable control, checkpoint frames the exact node. Default 'click'.",
            },
          },
          required: ["sessionId", "ref"],
        },
        handler: (args) =>
          a.verifyLocator(
            String(args.sessionId ?? ""),
            String(args.ref ?? ""),
            args.action === "type" || args.action === "checkpoint" ? args.action : "click",
          ),
      },
      {
        name: "wait",
        description:
          "Add a wait before the next step (performed live now, and recorded so replay waits too), ONLY when something is still loading. Prefer kind 'selector' (wait until the element at `ref` is visible/hidden) when you can name the element. Use 'streamIdle' for content that streams in or renders late — an LLM-generated answer, a chart that draws after its data arrives — where there is no single element to gate on: it waits until the DOM has been quiet AND no loading indicator (skeleton/spinner/progressbar/aria-busy) remains. 'delay' (fixed ms) is a last resort. Avoid 'networkIdle' — replay already settles navigation on network idle, so it is redundant and should not be added by default.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            kind: { type: "string", enum: ["delay", "networkIdle", "streamIdle", "selector"] },
            ms: { type: "number", description: "For kind=delay: milliseconds to wait." },
            timeoutMs: {
              type: "number",
              description:
                "Cap on the wait. For streamIdle this is a generous ceiling, not a target (default 120000) — it settles as soon as content finishes.",
            },
            quietMs: {
              type: "number",
              description:
                "For kind=streamIdle: how long the DOM must be mutation-free to count as settled (default 800).",
            },
            busySelector: {
              type: "string",
              description:
                "For kind=streamIdle: override the loading-indicator selector, for an app whose 'still working' marker the defaults don't catch.",
            },
            ref: { type: "string", description: "For kind=selector: the element ref to wait on." },
            state: { type: "string", enum: ["visible", "hidden"], description: "For kind=selector." },
          },
          required: ["sessionId", "kind"],
        },
        handler: (args) => {
          const sessionId = String(args.sessionId ?? "");
          const timeoutMs = args.timeoutMs ? Number(args.timeoutMs) : undefined;
          if (args.kind === "delay") return a.wait(sessionId, { kind: "delay", ms: Number(args.ms ?? 0) });
          if (args.kind === "networkIdle") return a.wait(sessionId, { kind: "networkIdle", timeoutMs });
          if (args.kind === "streamIdle") {
            return a.wait(sessionId, {
              kind: "streamIdle",
              quietMs: args.quietMs ? Number(args.quietMs) : undefined,
              timeoutMs,
              busySelector: args.busySelector ? String(args.busySelector) : undefined,
            });
          }
          if (args.kind === "selector") {
            return a.wait(sessionId, {
              kind: "selector",
              ref: String(args.ref ?? ""),
              state: args.state === "hidden" ? "hidden" : "visible",
              timeoutMs,
            });
          }
          throw new Error(`unknown wait kind: ${String(args.kind)}`);
        },
      },
      {
        name: "checkpoint",
        description:
          "Add a visual checkpoint (compared against a baseline on replay) — the test's actual assertion. Call this ONLY when the instruction explicitly asks for one: \"take a screenshot\", \"capture\", \"snapshot\", \"checkpoint\", or \"check/verify this screen\". Do NOT add a checkpoint on your own initiative, after every step, or just to make the test 'assert something' — most actions are not assertions. When asked, record it here (not as an observe screenshot). Give a stable, meaningful name.\n\nTWO independent choices:\n• WHAT to capture — mode 'element' (a specific component, by ref), 'fullpage' (the whole screen), or 'region' (a rect).\n• HOW to compare — compareMode 'pixel' (default: exact pixel-to-pixel diff) or 'context' (an LLM judge reads both screenshots). Pick 'pixel' for deterministic UI, and add masks over volatile sub-areas (timestamps, ids) or raise threshold slightly for minor rendering noise. Pick 'context' when the content legitimately differs every run — LLM-generated text, live figures, anything you could not mask into determinism — and say in `prompt` what counts as broken. Getting this wrong is the most common cause of a useless test: a pixel checkpoint over generated content fails every run, and a context checkpoint over static UI misses real regressions.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            name: { type: "string", description: "A stable, meaningful checkpoint name (part of the baseline key)." },
            mode: { type: "string", enum: ["element", "fullpage", "region"], description: "element (default), fullpage (whole screen), or region (a rect)." },
            ref: { type: "string", description: "For mode=element: the element ref to capture." },
            rect: {
              type: "object",
              description: "For mode=region: the rectangle to clip.",
              properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
              required: ["x", "y", "width", "height"],
            },
            masks: {
              type: "array",
              description:
                "Regions (rects) the diff should ignore — volatile sub-areas. Pixel mode only (the context judge ignores them; describe what to overlook in `prompt` instead).",
              items: {
                type: "object",
                properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
                required: ["x", "y", "width", "height"],
              },
            },
            compareMode: {
              type: "string",
              enum: ["pixel", "context"],
              description:
                "How to compare against the baseline. 'pixel' (default) = exact pixel-to-pixel diff, for deterministic UI. 'context' = an LLM judge, for content that is different every run.",
            },
            prompt: {
              type: "string",
              description:
                "For compareMode=context: what the judge should check, phrased so that legitimate variation passes and real breakage fails — e.g. \"both are AI-generated summaries; ignore that the wording and numbers differ; fail only if the current one is empty, truncated, an error, or visibly malformed\". Omit to use the team's default judge prompt.",
            },
            threshold: {
              type: "number",
              description:
                "Pixel mode only: max mismatched-pixel ratio (0..1) tolerated before the diff is flagged. Omit unless a specific rendering wobble needs slack — prefer a mask over a loose threshold, which hides real regressions everywhere on the screen.",
            },
          },
          required: ["sessionId", "name"],
        },
        handler: (args) =>
          a.checkpoint(String(args.sessionId ?? ""), {
            name: String(args.name ?? ""),
            mode:
              args.mode === "fullpage" || args.mode === "region" || args.mode === "element"
                ? args.mode
                : undefined,
            ref: args.ref ? String(args.ref) : undefined,
            rect: args.rect as CheckpointInput["rect"],
            masks: args.masks as CheckpointInput["masks"],
            compareMode: args.compareMode === "context" ? "context" : args.compareMode === "pixel" ? "pixel" : undefined,
            prompt: args.prompt ? String(args.prompt) : undefined,
            threshold: args.threshold !== undefined ? Number(args.threshold) : undefined,
          }),
      },
      {
        name: "finish_session",
        description:
          "Finish the session: assemble the recorded steps into a draft test and end the session. Returns the draft testId and a warning if it has no checkpoints. Finishing with zero checkpoints IS allowed (the draft just carries that warning) — do NOT invent a checkpoint to avoid the warning; only the user/plan decides what to assert. INTERACTIVE sessions end ONLY on the user's explicit instruction: do not call this until the user tells you to finish or save, and then pass confirm: true — the server refuses an interactive finish without it. BATCH sessions finish when the plan's steps are done; confirm is not required. A human reviews and promotes the draft in the Varys web app.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            confirm: {
              type: "boolean",
              description:
                "Set true ONLY when the user has explicitly told you to finish/save the session. Required to finish an INTERACTIVE session; ignored in batch.",
            },
          },
          required: ["sessionId"],
        },
        handler: (args) => a.finish(String(args.sessionId ?? ""), { confirm: Boolean(args.confirm) }),
      },
      {
        name: "discard_session",
        description:
          "Throw the session away WITHOUT saving anything: close the browser and drop every recorded step. Use this instead of finish_session when the session went wrong and its steps are not worth keeping — the wrong app or page, a flow that turned out to be a dead end, or a restart after a mistake. Saving a junk draft just to end the session makes work for whoever reviews the queue, so discard it instead. This is NOT how you end a good session (use finish_session) and it cannot be undone. As with finishing, do not discard an interactive session on your own initiative — ask the user first.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            confirm: {
              type: "boolean",
              description:
                "Must be true — attests that you intend to lose the recorded steps. The server refuses without it.",
            },
          },
          required: ["sessionId", "confirm"],
        },
        handler: (args) => {
          if (!args.confirm) {
            throw new Error(
              "discard_session throws away every recorded step and cannot be undone. If that is really what you want, call it again with confirm: true; if you meant to KEEP the work, call finish_session instead.",
            );
          }
          return a.discard(String(args.sessionId ?? ""));
        },
      },
    ];
  }
}
