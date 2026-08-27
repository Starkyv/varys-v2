import type { IncomingHttpHeaders } from "node:http";
import { Body, Controller, Get, Headers, HttpException, Inject, Post, Res } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { RepairJobsService } from "../repair-jobs/repair-jobs.service";
import type { PinAssertionInput } from "./authoring-session.service";
import { AuthoringInstructionsService } from "./authoring-instructions.service";
import {
  AuthoringSessionService,
  type CheckpointInput,
  type TestEditInput,
} from "./authoring-session.service";
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

/** A rectangle in screenshot-pixel space — a checkpoint's region or one of its masks. */
const RECT_SCHEMA = {
  type: "object",
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
  },
  required: ["x", "y", "width", "height"],
} as const;

/** The waits an editor can author. Recorded `selector` waits are preserved server-side and
 *  removed by position via `dropRecordedWaits`, never rewritten here. */
const EDITABLE_WAIT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["delay", "networkIdle", "streamIdle"] },
    ms: { type: "number", description: "For kind=delay: milliseconds." },
    timeoutMs: { type: "number" },
    quietMs: { type: "number", description: "For kind=streamIdle: mutation-free window that counts as settled." },
  },
  required: ["kind"],
} as const;

/** The locator signals an edit can set (empty string clears one); everything else the recorder
 *  captured is preserved, so an edit never collapses the bundle to a single selector. */
/** One side of a pinned assertion (Slice 19, slice 12). Shared by `left` and `right` so the two
 *  cannot drift into describing the same thing differently. */
const ASSERTION_SIDE_SCHEMA = {
  type: "object",
  properties: {
    ref: {
      type: "string",
      description:
        "The element ref (from observe) this side reads. Captured into a full multi-signal fingerprint, exactly as a click is — pin to the element, never to a selector you wrote.",
    },
    as: {
      type: "string",
      enum: ["text", "number", "sum-number", "count", "exists"],
      description:
        "How this side's text becomes a comparable value. `text` = its text; `number` = its text parsed as a number ($1,234 and 12% both parse); `count` = how many elements match; `sum-number` = the sum of every matching element's number; `exists` = is it there (true/false), for which 'not there' is the ANSWER and not a failure.",
    },
    selector: {
      type: "string",
      description:
        "Required for `count` / `sum-number` ONLY, and rejected elsewhere: a selector matching EVERY member of the set (e.g. \"#invoice .amount\"). A single ref marks one winner by design, so it cannot express a set — but keep the ref too, since it supplies the fingerprint and the frame the set is searched inside.",
    },
    literal: {
      type: ["string", "number"],
      description:
        "A fixed value instead of an element — right-hand side only. Use for \"the header equals 'Total'\" or \"the count is greater than 0\".",
    },
  },
} as const;

const LOCATOR_PATCH_SCHEMA = {
  type: "object",
  properties: {
    testId: { type: "string", description: "The target's data-testid — the strongest, self-healing signal." },
    selectorOverride: { type: "string", description: "A raw CSS/Playwright selector, tried first and used as-is when it matches exactly one element." },
    role: { type: "string" },
    accessibleName: { type: "string" },
    text: { type: "string" },
  },
} as const;

/**
 * The toolset a Repair Agent principal may reach (ADR-0005 / slice 02): the repair path plus the
 * perception and interaction tools needed to investigate a parked page. Everything else is absent
 * from `tools/list` AND unresolvable in `tools/call`, so this is a capability boundary, not a hint.
 *
 * Three deliberate exclusions:
 *  - `open_session`, `checkpoint`, `pin_assertion`, `declare_unpinnable_assertion`,
 *    `finish_session`, `discard_session` — authoring a NEW test is a human act; an agent that could
 *    open an Authoring Session could invent tests unattended. The two assertion tools sit here for
 *    a sharper reason than the rest: an agent able to DECLARE a check could answer a red run by
 *    writing a new assertion that passes, which is the failure the whole repair-safety story is
 *    built to prevent. A drainer changes assertions only through `edit_test`, which refuses any id
 *    the test does not already declare.
 *  - `failed_runs` — a cross-test read. A drainer is handed its work by the job it claimed; it has
 *    no business browsing every other test's failures.
 *  - `find_elements` — read-only perception, and arguably harmless for a drainer diagnosing why an
 *    assertion could not read a value. Withheld anyway: widening an agent's capability surface is
 *    a decision to take deliberately, not a side effect of the slice that introduced the tool.
 *  - baseline approval — not an MCP tool at anyone's disposal, and permanently off-limits to an
 *    agent per DESIGN.md §4 (approving deletes the previous baseline with no rollback).
 */
const AGENT_TOOLS: readonly string[] = [
  "claim_repair_job",
  "release_repair_job",
  "report_repair",
  "report_triage",
  "open_repair_session",
  "close_repair_session",
  "read_test",
  "edit_test",
  "try_locator",
  "apply_fix",
  "goto_step",
  "observe",
  "click",
  "hover",
  "navigate",
  "type",
  "verify_locator",
];

/**
 * Tools only an AGENT principal may see (slice 03). Draining the queue is a machine's job: a
 * human who wants a test repaired opens a Repair Session on it directly, and a claim taken by a
 * person is a claim no drainer can finish and nothing can lapse. Filtered out of `tools/list` and
 * `tools/call` for a human exactly as `AGENT_TOOLS` filters the other way, so an out-of-scope
 * tool reads as "Unknown tool" for either principal.
 */
const AGENT_ONLY_TOOLS: readonly string[] = [
  "claim_repair_job",
  "release_repair_job",
  "report_repair",
  "report_triage",
];

/**
 * Tools that CHANGE a test, and therefore need a claim on a `repair` job specifically (Slice 19,
 * slice 08).
 *
 * This is the enforcement half of "a triage claim grants observation only". It is structural rather
 * than advisory: a drainer holding a triage claim reaches the page, the definition and the failure
 * to READ them, and is refused here the moment it tries to write — no matter how convinced it is
 * that it knows the fix.
 *
 * `report_repair` is on the list because it is the act that makes a repair stand; it also refuses a
 * triage job on its own, so the two checks agree rather than one covering for the other.
 *
 * Baseline approval is absent for a different reason: it is not an MCP tool at all, for anyone.
 * Per DESIGN.md §4 approving deletes the previous baseline with no rollback, so an agent that could
 * approve one could permanently erase the evidence that a regression happened.
 */
const REPAIR_CLAIM_TOOLS: readonly string[] = ["apply_fix", "edit_test", "report_repair"];

/**
 * For an agent principal: which arguments of a tool name the TEST it would reach, and whether one
 * is mandatory. Declared per tool rather than sniffed off the argument names, because `testId` on
 * `try_locator`/`apply_fix` is the target's *data-testid* — treating that as a Varys test id would
 * check the scope of the wrong thing entirely.
 *
 * A tool listed here with none of its id arguments supplied is addressing an open SESSION instead;
 * that is covered separately, and twice over: `assertOwner` refuses a session this principal does
 * not own, and the claim on the session's test is re-checked on every call (slice 04) so a
 * released or lapsed claim cannot be outlived by a session opened under it.
 */
const AGENT_TEST_SCOPE: Record<string, { args: readonly ("testId" | "runId")[]; required: boolean }> = {
  open_repair_session: { args: ["runId", "testId"], required: true },
  read_test: { args: ["testId"], required: false },
  edit_test: { args: ["testId"], required: false },
};

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
    @Inject(RepairJobsService) private readonly repairJobs: RepairJobsService,
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
      // For an agent principal, a tool outside its scope is reported exactly like a tool that
      // does not exist — the same reasoning as the not-found on another user's session id.
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
      // The scope half of ADR-0005: a Repair Agent reaches only the tests covered by a job it
      // has claimed. A human principal is untouched by this.
      if (user.kind === "agent") {
        await this.assertAgentScope(name ?? "", args, user);
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

  /**
   * Refuse a Repair Agent that is reaching for a test no claimed job of its own covers
   * (ADR-0005). Thrown as a plain error, so it reaches the caller as an `isError` tool result
   * with a message a drainer can act on.
   *
   * Two things are checked, because a claim can end in two ways: the test named by an argument
   * must be covered by a claim this principal holds, and — for a call addressing an open repair
   * SESSION — the claim that session was opened under must still hold. The second is what makes
   * revocation immediate: releasing a job, or letting its lease lapse, stops the tools working on
   * the next call rather than when the browser eventually closes.
   */
  private async assertAgentScope(
    name: string,
    args: Record<string, unknown>,
    user: McpPrincipal,
  ): Promise<void> {
    // A session-addressed tool: the session was opened under a claim, but a claim can be released
    // or lapse while the browser is still parked — so ownership of the session is NOT enough. The
    // claim is re-checked on every call, which is what makes "losing the claim revokes tool
    // access immediately" true rather than true-until-the-session-closes.
    //
    // `close_repair_session` is exempt on purpose: refusing it would leave a real browser running
    // with no way for its owner to shut it down, which is a worse outcome than letting a drainer
    // tidy up after a claim it no longer holds. It changes nothing about any test.
    const sessionId = args.sessionId === undefined ? "" : String(args.sessionId);
    if (sessionId && name !== "close_repair_session") {
      const sessionTestId = this.authoring.sessionTestId(sessionId);
      if (sessionTestId && !(await this.repairJobs.hasClaimOn(user.id, sessionTestId))) {
        throw new Error(
          `${user.name} no longer holds a claim on test ${sessionTestId} — the claim was released or has lapsed, so this session may no longer change it. Claim the job again, or close the session.`,
        );
      }
      // A session opened under a TRIAGE claim may drive and observe, and may not write (slice 08).
      if (sessionTestId) await this.assertMayMutate(name, sessionTestId, user);
    }

    const scope = AGENT_TEST_SCOPE[name];
    if (!scope) return; // nothing else names a test: the claim re-check above is the whole check

    const ids: string[] = [];
    for (const arg of scope.args) {
      const raw = args[arg];
      if (raw === undefined || raw === null || String(raw) === "") continue;
      const testId = arg === "runId" ? await this.repairJobs.testIdForRun(String(raw)) : String(raw);
      // An unresolvable runId is left to the tool's own not-found; there is no test to scope to.
      if (testId) ids.push(testId);
    }
    if (ids.length === 0) {
      if (!scope.required) return;
      throw new Error(
        `${user.name} must name the test it has claimed a repair job for — pass the job's runId or testId.`,
      );
    }
    for (const testId of ids) {
      if (!(await this.repairJobs.hasClaimOn(user.id, testId))) {
        throw new Error(
          `${user.name} has no claimed repair job for test ${testId}. Claim the job for this test first — an agent credential may only touch tests covered by a claim it holds.`,
        );
      }
      await this.assertMayMutate(name, testId, user);
    }
  }

  /**
   * Refuse a WRITE attempted under a triage claim (Slice 19, slice 08).
   *
   * A Triage Job's only output is a written finding on the run; it may not change the test, and
   * that is enforced here rather than asked for in a prompt. The check is "does a REPAIR claim
   * exist on this test?" rather than "what kind is the claim?", because a drainer can hold both —
   * a repair claim on a broken locator and a triage claim on the same test's pixel regression — and
   * only the first of those grants the write.
   *
   * The message says what to do instead, because the drainer is not misbehaving: it has correctly
   * diagnosed something and reached for the wrong verb.
   */
  private async assertMayMutate(
    name: string,
    testId: string,
    user: McpPrincipal,
  ): Promise<void> {
    if (!REPAIR_CLAIM_TOOLS.includes(name)) return;
    if (await this.repairJobs.hasClaimOfKind(user.id, testId, "repair")) return;
    throw new Error(
      `${name} needs a REPAIR claim on test ${testId}, and ${user.name} holds a triage claim on it. A triage job diagnoses and never fixes: drive to the failure, look, and call report_triage with what you found. The run stays red — that is the point, not a shortcoming.`,
    );
  }

  /** The MCP tool surface for this principal. A human sees all of it; a Repair Agent sees only
   *  `AGENT_TOOLS` (ADR-0005) — the same filter `tools/list` and `tools/call` read, so a tool an
   *  agent cannot list is also a tool it cannot call.
   *
   *  Slice 2 = open/finish; Slices 3/4 add perception, interaction, and checkpoint tools to this
   *  list. Promotion is deliberately NOT a tool (web-UI only; Claude must not be able to
   *  self-promote — ADR 0001 / PRD safety). */
  private tools(user: McpPrincipal): McpTool[] {
    const all = this.allTools(user);
    return user.kind === "agent"
      ? all.filter((t) => AGENT_TOOLS.includes(t.name))
      : all.filter((t) => !AGENT_ONLY_TOOLS.includes(t.name));
  }

  private allTools(user: McpPrincipal): McpTool[] {
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
        name: "claim_repair_job",
        description:
          "Take the next queued job for yourself — a REPAIR job or a TRIAGE job; check `kind`. Returns the job id, the test, its Brief, the step that failed with the run's error, and `claimExpiresAt` — the instant your claim lapses.\n\n`kind: \"triage\"` is a READ-ONLY job, for a failure nobody may fix automatically — a pixel regression, a failed judge, a false assertion, a crash, a timeout. Drive to the failure, look, and call report_triage with what you found. apply_fix and edit_test are refused under a triage claim, and the run stays red on purpose: the value is the explanation, not a green. `kind: \"repair\"` is the fix path — report it with report_repair. Returns `job: null` when the queue is empty, which is the normal answer, not an error: stop and try again on your next drain rather than retrying in a loop.\n\nA claim is exclusive and first-claim-wins: nobody else can see or take this job while your claim holds, and while it holds you may read and edit THAT test (open_repair_session, read_test, edit_test, try_locator, apply_fix) — and no other. It is also a deadline: if you stop reporting before `claimExpiresAt`, the job returns to the queue for someone else and the attempt is counted against it. If you cannot fix it, call release_repair_job rather than going quiet — that returns it immediately. `attemptsRemaining` tells you how many tries the job has left before Varys abandons it.\n\nRead the `brief` before you repair anything: every repair has to be justified against a clause of it when you call report_repair, and one that cannot be is refused and reverted. A test with no Brief cannot be repaired automatically at all.\n\n`failingAssertion` is set when an ASSERTION is what made the run red — and then `failingStep` is null, because every step of that run passed. Read `repairable`: `true` means the assertion's extraction target no longer resolves, which is a broken locator like any other — re-pin that side with edit_test (`assertions: [{id, left|right: {...}}]`) and report it as a repair. `false` means the values were both read and they DISAGREE, or one could not be used as asked; there is nothing to re-pin, the job you are holding will be a triage job, and re-pinning an assertion until its numbers agree would hide the exact bug it exists to catch. `side` says which target to fix.\n\n`clusterTests` is the FAILURE CLUSTER: every test the same app change broke, and exactly what your claim reaches. Repair the anchor (`testId`) only — Varys fans your fix out across the rest when you report, as ONE reviewable change. Do not try to repair them individually, and do not describe the job as being about one test when it covers several.",
        inputSchema: { type: "object", properties: {} },
        handler: async () => ({ job: await this.repairJobs.claimNext(user.id) }),
      },
      {
        name: "release_repair_job",
        description:
          "Give a job you claimed back to the queue, right away — 'I can't fix this one.' Use it whenever you stop working on a claimed job for any reason other than reporting a repair; it beats letting the claim lapse, which parks the work until the deadline passes. It counts as one attempt either way, so a job you keep claiming and releasing is eventually abandoned rather than draining you forever.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: { type: "string", description: "The `jobId` claim_repair_job handed you." },
          },
          required: ["jobId"],
        },
        handler: (args) => this.repairJobs.release(user.id, String(args.jobId ?? "")),
      },
      {
        name: "report_repair",
        description:
          "Report that you have repaired the test of a job you hold, and close the job. Call it AFTER the fix is written (apply_fix, or edit_test) — it records what you did against the version you wrote and finishes the job; it does not write anything itself, so a report with no version behind it is refused.\n\nEVERY repair is gated on its `justification`. You must name the clause of the test's BRIEF (claim_repair_job handed it to you) that the element you re-pinned to satisfies, and show it is the SAME control the step was always exercising — renamed, re-worded or re-marked-up, not a different control that happens to look right. A judge reads that claim against the Brief and the actual before/after signals. If it does not hold, the repair is ABANDONED: your version is reverted, the test goes back to what it said before, and the run stays failed. So if the control the test used is simply GONE, do not re-pin to the nearest plausible substitute — call release_repair_job instead.\n\nWhat it does NOT do, and what you must therefore not claim: it does not turn the failing run green. The version you wrote is saved UNREVIEWED and waits for a human to accept or reject it, and the run that failed is still failed. Report your work as a proposed fix awaiting review — never as fixed. The response carries the version number, the run's unchanged status, and the wording to use.\n\nIf this job covers a Failure Cluster, the fix you applied to the anchor is applied to every other test in it here, as one reviewable change accepted or rejected together — `clusterTestIds` says which. If the fix cannot be written across all of them, NONE of it stands: everything is reverted and the job goes back in the queue.\n\nA re-run IS queued for you against the repaired definition (one per repaired test), and the anchor's id comes back as `rerunId`. If it verifies it reads HEALED — amber, a review queue item — not passed. So \"a re-run is under way\" is accurate; \"the test passes now\" is not, however the re-run turns out.\n\nReporting ends your claim, so your access to that test stops here: do everything you need to do to the test first, then report. If you could NOT fix it, call release_repair_job instead.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: { type: "string", description: "The `jobId` claim_repair_job handed you." },
            summary: {
              type: "string",
              description:
                "What you changed and why, in a couple of sentences — this is what the reviewer reads beside the version, so name the element you re-pinned to and the signal it now matches on.",
            },
            justification: {
              type: "string",
              description:
                "Which clause of the test's BRIEF the element you re-pinned to satisfies, and the evidence that it is the SAME control the step was exercising before — quote the clause, then say what changed about the element (its label, accessible name, test id, markup, position) and what shows it is still that control. Do NOT argue that a different element serves the same purpose: sameness of purpose is not sameness of control, and it is refused. This is judged, and a claim that does not hold abandons the repair.",
            },
          },
          required: ["jobId", "summary", "justification"],
        },
        handler: (args) =>
          this.repairJobs.reportRepair(
            user.id,
            String(args.jobId ?? ""),
            String(args.summary ?? ""),
            String(args.justification ?? ""),
          ),
      },
      {
        name: "report_triage",
        description:
          "Report what you found on a TRIAGE job you hold, and close it. This is the only output a triage job has, and the only write it is allowed: one paragraph, recorded on the failing run and shown to a human beside the failure.\n\nWrite the CAUSE, not the symptom. \"The chart is empty because /api/metrics returns 401 for the seeded user\" is the finding worth having; \"the chart did not render\" is what the run already said. Say what you saw, where you saw it, and what you think is responsible — and if you are not sure, say what you ruled out.\n\nWhat it does NOT do, and what you must therefore not claim: it changes NOTHING. The run is still red afterwards, no version of the test is written, and no baseline is touched. A diagnosis is not a fix. If you believe you know the repair, say so IN the finding and leave it to a human — do not attempt apply_fix or edit_test, which are refused under a triage claim.\n\nIf you could not work out why it failed, call release_repair_job instead: an empty finding is refused, because a triage job closed with nothing written is indistinguishable later from one that explained nothing.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: { type: "string", description: "The `jobId` claim_repair_job handed you." },
            finding: {
              type: "string",
              description:
                "What is actually wrong, in plain prose, for a human who has not looked at the page. Cause over symptom.",
            },
          },
          required: ["jobId", "finding"],
        },
        handler: (args) =>
          this.repairJobs.reportTriage(user.id, String(args.jobId ?? ""), String(args.finding ?? "")),
      },
      {
        name: "open_repair_session",
        description:
          "Open an existing test for diagnosis and editing, by re-driving it yourself. Takes either a `runId` (a specific failure) or a `testId` (that test's most recent failure — use this when the user names a test rather than a run). Launches a browser, seeds the run's environment, replays the test's OWN steps (the exact version that ran, with the same drive a Run uses) up to the step that failed, and PARKS there — so the page the failing step faced is live in front of you. Returns why it failed: the run's error, what the recorded locator was looking for (`recordedLocator`), the matcher's verdict on that locator against the page as it is now (`diagnosis`), every element actually on the page (`nodes`, with testId/id/duplicate flags), and a screenshot. Investigate with observe/hover, move to any other step with goto_step, and test candidate locators with try_locator.\n\nThis session can change the test in any way the user asks. A broken locator goes through try_locator → apply_fix, which re-checks the candidate against the live page and refuses one that does not resolve. Everything else — a checkpoint's name, capture mode, compare mode, judge prompt, threshold or masks, a typed value, a navigate URL, waits, adding/removing/reordering steps, re-capturing a step's element off the live page — goes through read_test → edit_test. Both write a new audited version of the test with the previous one retained; always tell the user what you changed and the new version number. What it does NOT do is record a new test: `checkpoint` and `finish_session` are refused, because there is no draft here.\n\nRead `replay.note` first — if the drive broke EARLIER than the run did, the step you were sent to was never reached, so deal with the earlier step first (goto_step with that index). Close with close_repair_session when done.",
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
            owner: { id: user.id, email: user.email, kind: user.kind },
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
          "WRITE the fix onto the test. Applies your locator patch to the step under repair and saves it as a new test version — the same operation, validation and audit trail as editing it by hand in the web app. Two things are enforced before anything is written: the candidate is re-verified against the live page (a patch that is not-found or ambiguous is REFUSED — this can only ever replace a broken locator with one that demonstrably resolves), and the step at that index must still be the step you diagnosed (if the test changed since the session opened, the write is refused rather than landing on the wrong step). The previous version is retained, so this appends rather than overwrites. Use try_locator to find the right patch FIRST — apply the one that came back `recommend: true`. A patch that resolves on a weak signal is still written, but comes back with a `warning`: report that caveat instead of declaring the test fixed. Tell the user the new version number afterwards. This tool is the LOCATOR path only, and only for the step the session is parked on — for any other change to the test (a checkpoint's settings, a typed value, a URL, waits, adding/removing/reordering steps, or a locator on a different step) use edit_test.",
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
        name: "goto_step",
        description:
          "Re-park the repair session on a DIFFERENT step: re-drive the test from the top with a fresh page and stop at `stepIndex`, so the live page in front of you is the one THAT step faces. Use it when `replay.note` says the path broke earlier than the Run did, when the user asks about a step other than the one that failed, and after edit_test — the parked page is always the drive from BEFORE an edit, so this is how you see an edit take effect and re-check it with try_locator. Returns the same diagnosis payload as open_repair_session, for the new step. It re-drives the test as it stands NOW (including edits made this session), which costs one full prefix drive — cheap enough to move around freely, not free enough to call between every try_locator.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            stepIndex: { type: "number", description: "0-based step to park on (as reported by read_test)." },
          },
          required: ["sessionId", "stepIndex"],
        },
        handler: (args) => a.gotoStep(String(args.sessionId ?? ""), Number(args.stepIndex)),
      },
      {
        name: "read_test",
        description:
          "Read a test's CURRENT definition as an editable surface: every step with its 0-based `index`, human label, and every field an edit can address, plus every declared ASSERTION with its stable id and pinned form — the checkpoint's name/captureMode/compareMode/prompt/threshold/masks/rect, a type step's `value`, a navigate step's `url`, the waits before it, and its `locator`. ALWAYS call this before edit_test: an edit is keyed by step index, and an index inferred from a run's error message or from your memory of the flow is how you edit the wrong step. It reports the LATEST version — which is what an edit lands on, even inside a repair session opened on an older one. Pass `sessionId` to read the test that session is repairing, or `testId` to read any test (no session needed). Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "An open repair session — reads the test it is repairing." },
            testId: { type: "string", description: "Instead: any test, by the id in its web-app URL." },
          },
        },
        handler: (args) =>
          a.readTest({
            sessionId: args.sessionId ? String(args.sessionId) : undefined,
            testId: args.testId ? String(args.testId) : undefined,
          }),
      },
      {
        name: "edit_test",
        description:
          "CHANGE ANYTHING in a test, and save it as a new audited version. This is the general editor: whatever the user asks to change about an existing test, do it here.\n\n• Any step field — a checkpoint's `name` (baselines follow the rename), `captureMode` (element/fullpage/region), `rect`, `compareMode` (pixel/context), judge `prompt`, `threshold`, `masks`; a type step's `value`; a navigate step's `url`; the `waitBefore` list.\n• Any locator — `locator` patches the recorded signals; `ref` RE-CAPTURES the element off the live page of a repair session (use this when the element changed wholesale rather than one of its signals).\n• Structure — `remove` a step, `inserts` to add one (a `ref` builds it on a real captured fingerprint that self-heals; a `selector` is used as-is with nothing behind it), `order` to reorder.\n• Any ASSERTION — `assertions` rewords a check, re-pins either side's extraction target (`left`/`right`, the repair for an assertion whose target no longer resolves), or removes one. Never re-pin an assertion whose relation was FALSE: that is the app disagreeing with itself, and re-pinning it hides the bug.\n• The test itself — `name`, `notes` (these live on the test row, so they write no new version).\n\nCall read_test FIRST and key every edit off the indices it reports; after an edit that adds, removes or reorders steps, the indices in the response are the new truth. Only make the change the user asked for. The write goes through the same path as the web editor — same validation, previous version retained — and the response lists what was applied plus the new version number, which you must report back.\n\nUnlike apply_fix, an edit here is NOT verified against a live page: it will happily write a locator that does not resolve. When you edit a locator this way, verify it (goto_step to re-drive, then try_locator) before you tell the user it is fixed.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "An open repair session: supplies the test being repaired, and the live page any `ref` refers to." },
            testId: { type: "string", description: "Instead: the test to edit, by the id in its web-app URL. No session needed." },
            name: { type: "string", description: "Rename the test." },
            notes: { type: "string", description: "Set the test's free-form notes (empty string clears them)." },
            defaults: {
              type: "array",
              description: "Replace the test-level default waits applied before every wait-supporting step.",
              items: EDITABLE_WAIT_SCHEMA,
            },
            steps: {
              type: "array",
              description: "Per-step edits, each addressing the step at `index` (from read_test). Omitted fields are left untouched.",
              items: {
                type: "object",
                properties: {
                  index: { type: "number", description: "0-based index of the step to edit." },
                  remove: { type: "boolean", description: "Delete this step. The entry navigation (index 0) can't be removed." },
                  name: { type: "string", description: "Checkpoint only: rename it. Its baselines are moved onto the new name." },
                  captureMode: { type: "string", enum: ["element", "fullpage", "region"], description: "Checkpoint only: what is captured. element needs a locator, region needs a rect." },
                  rect: { ...RECT_SCHEMA, description: "Checkpoint only, region capture: the rectangle to clip." },
                  compareMode: { type: "string", enum: ["pixel", "context"], description: "Checkpoint only: exact pixel diff, or an LLM judge for content that legitimately differs every run." },
                  prompt: { type: "string", description: "Checkpoint only, compareMode=context: what the judge should check. Empty string clears it (falls back to the team default)." },
                  threshold: { type: "number", description: "Checkpoint only, pixel mode: max mismatched-pixel ratio (0..1)." },
                  masks: { type: "array", description: "Checkpoint only, pixel mode: the FULL list of diff-ignore regions (replaces the existing masks).", items: RECT_SCHEMA },
                  url: { type: "string", description: "Navigate only: the URL to go to. Keep the {{baseUrl}} token to stay environment-agnostic." },
                  value: { type: "string", description: "Type only: the literal value typed into the field." },
                  waitBefore: { type: "array", description: "Replace this step's authorable waits (recorded selector waits are preserved).", items: EDITABLE_WAIT_SCHEMA },
                  dropRecordedWaits: { type: "array", description: "Remove recorded selector waits by their 0-based position among this step's selector waits.", items: { type: "number" } },
                  ref: { type: "string", description: "Re-capture this step's locator from the element with this ref on the session's live page (requires sessionId)." },
                  locator: { ...LOCATOR_PATCH_SCHEMA, description: "Patch the step's locator signals; empty string clears one. Applied on top of `ref` when both are given." },
                },
                required: ["index"],
              },
            },
            inserts: {
              type: "array",
              description: "Steps to add, each anchored to an existing step by its current index. Nothing can be inserted above the entry navigation, or anchored to a step this same edit removes.",
              items: {
                type: "object",
                properties: {
                  atIndex: { type: "number", description: "The existing step to anchor to (current 0-based index)." },
                  position: { type: "string", enum: ["above", "below"] },
                  step: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["navigate", "click", "hover", "type", "screenshot"] },
                      url: { type: "string", description: "For navigate." },
                      ref: { type: "string", description: "For click/hover/type/element-checkpoint: capture the element off the session's live page. PREFER this — it records the full multi-signal fingerprint, which self-heals." },
                      selector: { type: "string", description: "For click/hover/type/element-checkpoint without a live page: a raw CSS/Playwright selector, used as-is. Nothing falls back behind it, so a stale one hard-fails the step." },
                      value: { type: "string", description: "For type: the literal value." },
                      name: { type: "string", description: "For screenshot: the checkpoint name (part of the baseline key — make it stable and meaningful)." },
                      captureMode: { type: "string", enum: ["element", "fullpage", "region"], description: "For screenshot; defaults to fullpage." },
                      rect: RECT_SCHEMA,
                      compareMode: { type: "string", enum: ["pixel", "context"] },
                      prompt: { type: "string" },
                      threshold: { type: "number" },
                      masks: { type: "array", items: RECT_SCHEMA },
                    },
                    required: ["type"],
                  },
                },
                required: ["atIndex", "position", "step"],
              },
            },
            order: {
              type: "array",
              description: "Reorder the steps: every surviving step's CURRENT 0-based index, listed once, in the order they should run. The entry navigation (0) must stay first.",
              items: { type: "number" },
            },
            assertions: {
              type: "array",
              description:
                "Edits to the test's declared ASSERTIONS, each addressing one by its stable `id` (from read_test). This is the assertion REPAIR path: an assertion whose extraction target no longer resolves is a broken locator like any other, and `left`/`right` re-pin it.\n\nWhat you must NOT do here: an assertion that FAILED because its relation is false — both values were read and they disagree — is the application being wrong, and re-pinning it until the numbers agree hides the exact bug the assertion exists to catch. Never touch an assertion for that reason. `claim_repair_job` tells you which case you have (`failingAssertion.repairable`).",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "The assertion's stable id, exactly as read_test reports it. Not editable — it is what its history hangs off." },
                  check: { type: "string", description: "Reword the plain-language check. Its id, and therefore every verdict already recorded under it, is untouched." },
                  left: { ...LOCATOR_PATCH_SCHEMA, description: "Re-pin the LEFT side's extraction target: a locator patch merged onto the recorded fingerprint, empty string clears a signal." },
                  right: { ...LOCATOR_PATCH_SCHEMA, description: "Re-pin the RIGHT side's extraction target. Refused when that side is a literal value rather than an element." },
                  remove: { type: "boolean", description: "Delete the assertion. Only when the user asks — deleting one silently stops a check nobody knows was there." },
                },
                required: ["id"],
              },
            },
          },
        },
        handler: (args) =>
          a.editTest({
            actor: { id: user.id, email: user.email, kind: user.kind },
            sessionId: args.sessionId ? String(args.sessionId) : undefined,
            testId: args.testId ? String(args.testId) : undefined,
            ...(args.name !== undefined ? { name: String(args.name) } : {}),
            ...(args.notes !== undefined ? { notes: String(args.notes) } : {}),
            ...(args.defaults !== undefined ? { defaults: args.defaults as TestEditInput["defaults"] } : {}),
            ...(args.steps !== undefined ? { steps: args.steps as TestEditInput["steps"] } : {}),
            ...(args.inserts !== undefined ? { inserts: args.inserts as TestEditInput["inserts"] } : {}),
            ...(args.order !== undefined ? { order: (args.order as unknown[]).map(Number) } : {}),
            ...(args.assertions !== undefined ? { assertions: args.assertions as TestEditInput["assertions"] } : {}),
          }),
      },
      {
        name: "close_repair_session",
        description:
          "Close a repair session and shut its browser down. Nothing is lost: a repair session holds no unsaved work — every edit it makes (apply_fix, edit_test) was already written to the test as its own version. Call it once you have reported the diagnosis and any changes you made.",
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
        name: "find_elements",
        description:
          "Get refs for elements you want to READ — the counterpart to observe, and the tool you need before pin_assertion.\n\n`observe` lists what you can ACT on: links, buttons, headings, anything clickable. The things an assertion reads are almost never any of those — a total in a `<span>`, a figure in a `<td>`, a count in a badge — so they never appear in a snapshot and you cannot reference them. This finds them by CSS selector and stamps a ref on each.\n\nWhat comes back is a ref per match plus the element's tag, its text, and its data-testid / id if it has one. Read the text: the most common way a pin goes wrong is pointing at a right-looking wrong node, and the text is how you catch that before you pin it.\n\nThe ref is what you then pass to pin_assertion, and that matters — the selector is only how the element was found here, once. What gets stored on the test is the full multi-signal fingerprint captured from the ref, the same one a click records, so the check survives a re-skin that would break the selector.\n\nFor a `count` or `sum-number` side, call this with the selector you intend to use for the SET and check `total` — that number is exactly what the assertion will read. Nothing is recorded and the page is unchanged, so this is always safe to call.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            selector: {
              type: "string",
              description:
                "A CSS selector for the elements to read, e.g. `[data-testid=\"total\"]` or `#invoice .amount`.",
            },
            limit: {
              type: "number",
              description: "Cap on how many matches are listed (default 20, max 100). `total` always reports the real count.",
            },
          },
          required: ["sessionId", "selector"],
        },
        handler: (args) =>
          a.findElements(
            String(args.sessionId ?? ""),
            String(args.selector ?? ""),
            args.limit !== undefined ? Number(args.limit) : undefined,
          ),
      },
      {
        name: "pin_assertion",
        description:
          "Declare an ASSERTION on the test — a check on a RELATIONSHIP between two things on the page, which no screenshot can express: a total against the sum of its column, a row count against a badge, a header against a fixed string. A checkpoint asks \"does this look like it did before?\"; an assertion asks \"do these two numbers still agree?\", and it catches the bug a pixel-perfect page can still have.\n\nCall this ONLY when the user or plan asks for such a check — same discipline as `checkpoint`. Do not invent assertions to make a test feel thorough.\n\nYou PIN it: you decide once, here, which elements to read and how to compare them, and every later run evaluates it in the worker with NO model call. That is the whole point — the check costs nothing to run nightly forever.\n\nThe vocabulary is FIXED and nothing else is accepted. Each side is read `as` one of: `text` (its text), `number` (its text parsed as a number), `count` (HOW MANY elements match), `sum-number` (the sum of every matching element's number), `exists` (is it there — true/false). The two sides are compared with `relation`: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, or `non-empty` (which reads the left side only, so pass no `right`). Numeric relations may carry a `tolerance` — always use one for money (0.01), so float arithmetic cannot manufacture a failure.\n\nPin to ELEMENTS, by `ref` from observe — never a selector you wrote. The ref is captured into the same multi-signal fingerprint a click records, which is what lets the check survive a re-skin. The one exception: `count` and `sum-number` read a SET, which a single ref cannot express, so those sides need `selector` as well (e.g. \"#invoice .amount\") — the ref still supplies the fingerprint and the frame the set lives in.\n\nThe server EVALUATES your pin against the live page before storing it. If a side cannot be read, the pin is REFUSED with the reason and nothing is recorded — fix it and call again. If both sides read but the relation is false, the pin is STORED and you are told: that is a finding about the application, and you must report it to the user rather than reword the check until it passes.\n\nIf the vocabulary genuinely cannot express the check — anything qualitative, \"the chart looks reasonable\", \"the layout isn't broken\" — do NOT force it into the nearest fit. A pin that is subtly wrong is worse than an honest fallback, because it looks exact. Call declare_unpinnable_assertion instead.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            id: {
              type: "string",
              description:
                "A stable, boring id for this check (letters, digits, - and _). It is the identity the assertion's pass/fail history hangs off — like a checkpoint name keys a baseline — so choose one that survives a rewording of `check`, e.g. \"total-matches-sum\".",
            },
            check: {
              type: "string",
              description:
                "The claim, in plain language, as a human will read it when it fails: \"The invoice total equals the sum of the line items\". Not a description of the mechanism — the claim.",
            },
            left: { ...ASSERTION_SIDE_SCHEMA, description: "The left-hand side: the element this check reads." },
            right: {
              ...ASSERTION_SIDE_SCHEMA,
              description:
                "The right-hand side: another element to read, or a fixed value via `literal`. Omit entirely for `non-empty`, which reads the left side only.",
            },
            relation: {
              type: "string",
              enum: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "non-empty"],
              description: "How the two coerced values are compared.",
            },
            tolerance: {
              type: "number",
              description:
                "Numeric relations only: slack, so a rounding difference is not a failure. Use 0.01 for money. Rejected on `contains` / `non-empty`, where it would be silently ignored.",
            },
          },
          required: ["sessionId", "id", "check", "left", "relation"],
        },
        handler: (args) =>
          a.pinAssertion(String(args.sessionId ?? ""), {
            id: String(args.id ?? ""),
            check: String(args.check ?? ""),
            left: (args.left ?? {}) as PinAssertionInput["left"],
            right: args.right as PinAssertionInput["right"],
            relation: args.relation as PinAssertionInput["relation"],
            tolerance: args.tolerance !== undefined ? Number(args.tolerance) : undefined,
          }),
      },
      {
        name: "declare_unpinnable_assertion",
        description:
          "Declare an assertion you could NOT pin, and say why — the honest exit from `pin_assertion`, and the right call whenever the fixed vocabulary cannot express the check.\n\nUse it for anything qualitative: \"the chart looks reasonable\", \"the dashboard isn't showing an error state\", \"the layout is intact\". These are real checks worth asserting; they just are not two extractions and a relation. Varys evaluates them on every run by handing the page to a vision judge, which answers in prose — approximate, marked as approximate everywhere it is shown, and still able to fail the run.\n\nWhat this tool exists to prevent is the near-miss: forcing a qualitative claim into `contains`, or eyeballing a total into an `eq` against a literal that happens to be right today. A pin that is subtly wrong is WORSE than an honest fallback, because it looks exact and nobody re-examines it.\n\nBut do not reach for this to avoid thinking. If the check compares two things on the page, pin it — that is almost always possible once you look for the two elements. Reserve this for checks that genuinely are not comparisons.\n\n`reason` is stored on the test and shown to the author beside the check, so write it for them: name WHICH part of the claim the vocabulary cannot express, specifically enough that they could rephrase it into a pinnable one if they would rather. \"Could not pin it\" is not a reason.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            id: {
              type: "string",
              description: "A stable, boring id (letters, digits, - and _) — the key this check's history hangs off.",
            },
            check: { type: "string", description: "The claim, in plain language, as the author stated it." },
            reason: {
              type: "string",
              description:
                "Which part of this check the fixed vocabulary cannot express, in terms the author can act on — e.g. \"'looks reasonable' is a judgement about the whole chart, not a comparison between two values on the page; there is no element pair to read.\"",
            },
          },
          required: ["sessionId", "id", "check", "reason"],
        },
        handler: (args) =>
          a.declareUnpinnableAssertion(String(args.sessionId ?? ""), {
            id: String(args.id ?? ""),
            check: String(args.check ?? ""),
            reason: String(args.reason ?? ""),
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
