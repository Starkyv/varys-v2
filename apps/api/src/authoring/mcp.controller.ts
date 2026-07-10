import { Body, Controller, Get, HttpException, Inject, Post, Res } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { AuthoringInstructionsService } from "./authoring-instructions.service";
import { AuthoringSessionService, type CheckpointInput } from "./authoring-session.service";
import { McpStatusService } from "./mcp-status.service";

/** The slice of the HTTP response we touch — avoids depending on express types directly
 *  (it's only available transitively via @nestjs/platform-express). */
interface HttpRes {
  status(code: number): unknown;
}

/**
 * The Varys authoring MCP server — a minimal JSON-RPC 2.0 endpoint over Streamable
 * HTTP (JSON-response mode) that Claude Code connects to at `/mcp`. It exposes the
 * authoring session as MCP tools that delegate to `AuthoringSessionService`; the same
 * tools are what a deterministic test drives (no LLM).
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

// Unauthenticated this slice (locked decision): Claude Code is a separate process with
// no browser cookie, and per-client tokens were declined. Accepted risk, DESIGN §11.
@Public()
@Controller("mcp")
export class McpController {
  constructor(
    @Inject(AuthoringSessionService) private readonly authoring: AuthoringSessionService,
    @Inject(McpStatusService) private readonly mcpStatus: McpStatusService,
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
    @Res({ passthrough: true }) res: HttpRes,
  ): Promise<unknown> {
    this.mcpStatus.touch(); // record activity so the web app can show "Claude Code active"
    let result: unknown;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.handle(m)))).filter(
        (r): r is JsonRpcResponse => r !== undefined,
      );
      result = out.length ? out : undefined;
    } else {
      result = await this.handle(body);
    }
    // Streamable HTTP: a POST carrying only notifications/responses (nothing to answer)
    // gets 202 Accepted with no body; a request gets its JSON-RPC response with 200.
    res.status(result === undefined ? 202 : 200);
    return result;
  }

  private async handle(msg: JsonRpcMessage): Promise<JsonRpcResponse | undefined> {
    const id = msg?.id ?? null;
    const isNotification = msg?.id === undefined || msg?.id === null;
    try {
      const result = await this.dispatch(msg?.method, msg?.params ?? {});
      return isNotification ? undefined : { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (isNotification) return undefined;
      const code = err instanceof MethodNotFound ? -32601 : -32603;
      return { jsonrpc: "2.0", id, error: { code, message: (err as Error).message } };
    }
  }

  private async dispatch(method: string | undefined, params: Record<string, unknown>): Promise<unknown> {
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
          tools: this.tools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
      case "tools/call":
        return this.callTool(params);
      default:
        throw new MethodNotFound(`Method not found: ${method}`);
    }
  }

  /** Run a tool; tool-execution failures surface as an `isError` result (not a JSON-RPC
   *  error), per the MCP spec, so Claude sees the message and can recover. */
  private async callTool(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name as string | undefined;
    const tool = this.tools().find((t) => t.name === name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await tool.handler((params.arguments as Record<string, unknown>) ?? {});
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
  private tools(): McpTool[] {
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
            startUrl: String(args.startUrl ?? ""),
            name: args.name ? String(args.name) : undefined,
            intent: args.intent ? String(args.intent) : undefined,
            mode: args.mode === "batch" ? "batch" : args.mode === "interactive" ? "interactive" : undefined,
          }),
      },
      {
        name: "observe",
        description:
          "Perceive the current page: a list of interactive/landmark elements, each with a stable `ref`, role, name, and (for fields) value. Target later actions by `ref`. Set screenshot=true to also get a base64 PNG for visual disambiguation. This screenshot is for YOUR perception only — it is NOT a checkpoint and records nothing in the test; if the user asks you to take or capture a screenshot, use the checkpoint tool instead.",
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
            remedy: {
              type: "string",
              enum: ["bind", "structural"],
              description: "If the locator depends on env-specific visible text, how to fix it (default: structural).",
            },
          },
          required: ["sessionId"],
        },
        handler: (args) =>
          a.click(
            String(args.sessionId ?? ""),
            { ref: args.ref ? String(args.ref) : undefined, text: args.text ? String(args.text) : undefined },
            { remedy: args.remedy === "bind" || args.remedy === "structural" ? args.remedy : undefined },
          ),
      },
      {
        name: "hover",
        description:
          "Hover an element (by ref or text) to reveal hover-only affordances (dropdown menus, a 'Read more →' link), then get a fresh snapshot so the revealed elements get refs. Reveal aid only — hovers are NOT recorded as steps; if a control only appears on hover, prefer clicking a stable container.",
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
          "Type a value into the field with the given ref. Declare `kind`: 'variable' (env-specific data → tokenized as {{name}}), 'static' (a fixed UI value, kept literal), or 'secret' (→ {{secret:name}}). A password field is ALWAYS recorded as a secret regardless. Omit kind to use a heuristic. The live value drives the app; the recorded value is tokenized.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            ref: { type: "string" },
            value: { type: "string", description: "The value to type (the live value; a password is never persisted)." },
            kind: { type: "string", enum: ["variable", "static", "secret"] },
            name: { type: "string", description: "Variable/secret name to use when tokenizing (defaults to the field id/name)." },
            remedy: { type: "string", enum: ["bind", "structural"] },
          },
          required: ["sessionId", "ref", "value"],
        },
        handler: (args) =>
          a.type(String(args.sessionId ?? ""), String(args.ref ?? ""), String(args.value ?? ""), {
            kind:
              args.kind === "variable" || args.kind === "static" || args.kind === "secret" ? args.kind : undefined,
            name: args.name ? String(args.name) : undefined,
            remedy: args.remedy === "bind" || args.remedy === "structural" ? args.remedy : undefined,
          }),
      },
      {
        name: "wait",
        description:
          "Add a wait before the next step (performed live now, and recorded so replay waits too), ONLY when a specific element is still loading. Prefer kind 'selector' (wait until the element at `ref` is visible/hidden). 'delay' (fixed ms) is a last resort. Avoid 'networkIdle' — replay already settles navigation on network idle, so it is redundant and should not be added by default.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            kind: { type: "string", enum: ["delay", "networkIdle", "selector"] },
            ms: { type: "number", description: "For kind=delay: milliseconds to wait." },
            timeoutMs: { type: "number" },
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
          "Add a visual checkpoint (a screenshot diffed against a baseline on replay) — the test's actual assertion. Call this ONLY when the instruction explicitly asks for one: \"take a screenshot\", \"capture\", \"snapshot\", \"checkpoint\", or \"check/verify this screen\". Do NOT add a checkpoint on your own initiative, after every step, or just to make the test 'assert something' — most actions are not assertions. When asked, record it here (not as an observe screenshot). mode 'fullpage' (the whole screen), 'element' (a specific component, by ref), or 'region' (a rect). Pass masks (rects) over volatile areas (timestamps, ids) as a best-effort proposal; a human finalizes them in review. Give a stable, meaningful name.",
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
              description: "Regions (rects) the diff should ignore — volatile sub-areas.",
              items: {
                type: "object",
                properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
                required: ["x", "y", "width", "height"],
              },
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
    ];
  }
}
