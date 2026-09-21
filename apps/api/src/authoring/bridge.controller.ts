import { Body, Controller, Get, Headers, Inject, type MessageEvent, Param, Post, Sse } from "@nestjs/common";
import type {
  AgentRunRequestBody,
  AgentRunRequestResult,
  AgentRunRequestState,
  BridgeChatState,
  BridgeHelperEvent,
  BridgeHelperPresence,
  BridgePairResult,
} from "@varys/review-contract";
import { interval, map, merge, type Observable } from "rxjs";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { Public } from "../auth/public.decorator";
import { AgentRunService } from "./agent-run.service";
import { BridgeService } from "./bridge.service";

/** Periodic SSE heartbeat (a `ping` the clients ignore) so idle proxies don't drop the stream. */
function heartbeat(): Observable<MessageEvent> {
  return interval(15_000).pipe(map((): MessageEvent => ({ data: "ping", type: "ping" })));
}

/**
 * The Bridge relay endpoints (Slice 15 — Author with AI). Two sides over SSE + POST:
 *  - helper side (`pair`, `helper/commands`, `helper/events`) — `@Public()` to the cookie guard
 *    because the helper has no browser session, but gated by the one-time pairing code → a
 *    chat-scoped bridge token. Declared first so the literal paths take precedence over `:chatId`.
 *  - web side (`POST /`, `helper`, `run-agent-test`, `:chatId`, `:chatId/prompt`, `:chatId/stream`)
 *    — cookie-authenticated and owner-scoped (the controller passes the better-auth user id to
 *    the service).
 *
 * Slice 17 adds the two web-side routes an Agent-Driven Test's Run control needs: `helper` (is
 * one listening?) and `run-agent-test` (ask it to run this). Slice 18 adds the third,
 * `run-request/:testId` (what became of the press?). All three are addressed by owner, never by
 * chat id.
 */
@Controller("authoring/bridge")
export class BridgeController {
  constructor(
    @Inject(BridgeService) private readonly bridge: BridgeService,
    // Answers "is this test runnable by an agent at all?" — the SAME method `start_agent_run`
    // asks, so the refusal a person gets on the button and the refusal their Claude would have
    // got a minute later cannot disagree. Checked here purely to fail before a Claude is
    // launched and subscription time is spent discovering it.
    @Inject(AgentRunService) private readonly agentRuns: AgentRunService,
  ) {}

  // ── helper side (pairing-code / bridge-token gated) ──

  @Public()
  @Post("pair")
  pair(@Body() body: { code?: string }): BridgePairResult {
    return this.bridge.claim(String(body?.code ?? ""));
  }

  @Public()
  @Sse("helper/commands")
  helperCommands(@Headers("x-bridge-token") token: string): Observable<MessageEvent> {
    return merge(
      this.bridge.helperCommands(String(token ?? "")).pipe(map((c): MessageEvent => ({ data: c }))),
      heartbeat(),
    );
  }

  @Public()
  @Post("helper/events")
  helperEvents(
    @Headers("x-bridge-token") token: string,
    @Body() body: { events?: BridgeHelperEvent[] },
  ): { ok: true } {
    this.bridge.helperEvents(String(token ?? ""), body?.events ?? []);
    return { ok: true };
  }

  // ── web side (cookie-authenticated, owner-scoped) ──
  // The literal paths below are declared BEFORE `:chatId`, or Nest would match `helper` and
  // `run-agent-test` as chat ids.

  @Post()
  create(@CurrentUser() user: AuthUser): BridgeChatState {
    return this.bridge.create(user.id);
  }

  /** Whether this user has a helper listening — what the Run control on an Agent-Driven Test is
   *  live or disabled by. */
  @Get("helper")
  helper(@CurrentUser() user: AuthUser): BridgeHelperPresence {
    return this.bridge.helperPresence(user.id);
  }

  /**
   * Ask your own Claude to run an Agent-Driven Test.
   *
   * There is no chat id in the request and deliberately so: the destination is derived from who
   * is signed in, so a request cannot address a helper the sender did not pair. Refusals are
   * distinguishable — 404 for an unknown test, 400 for a pinned one or an empty Checkpoint
   * Manifest, 409 for no paired helper, 401 for no session at all.
   */
  @Post("run-agent-test")
  async runAgentTest(
    @CurrentUser() user: AuthUser,
    @Body() body: AgentRunRequestBody,
  ): Promise<AgentRunRequestResult> {
    const testId = String(body?.testId ?? "");
    await this.agentRuns.assertRunnable(testId);
    const environmentId = String(body?.environmentId ?? "").trim() || null;
    const { chatId, state } = this.bridge.requestAgentRun(user.id, {
      testId: testId.trim(),
      environmentId,
    });
    return { chatId, request: state };
  }

  /**
   * What became of this user's request for this test (Slice 18).
   *
   * The press writes nothing durable, so between it and the Run appearing this endpoint is the
   * only account of what is happening — including `lapsed`, which is how a paired-but-wedged
   * helper stops being indistinguishable from a slow one.
   *
   * Owner-scoped like everything else on this side: a test id names a test, never somebody else's
   * request for it. Answers `none` for a test that was never asked about, rather than 404 — "no
   * request" is an answer, and the control asks on every poll.
   */
  @Get("run-request/:testId")
  runRequest(@CurrentUser() user: AuthUser, @Param("testId") testId: string): AgentRunRequestState {
    return this.bridge.runRequestState(user.id, String(testId ?? "").trim());
  }

  @Get(":chatId")
  state(@Param("chatId") chatId: string, @CurrentUser() user: AuthUser): BridgeChatState {
    return this.bridge.stateForOwner(chatId, user.id);
  }

  @Post(":chatId/prompt")
  prompt(
    @Param("chatId") chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { text?: string },
  ): { ok: true } {
    this.bridge.prompt(chatId, user.id, String(body?.text ?? ""));
    return { ok: true };
  }

  @Sse(":chatId/stream")
  webStream(@Param("chatId") chatId: string, @CurrentUser() user: AuthUser): Observable<MessageEvent> {
    return merge(
      this.bridge.webEvents(chatId, user.id).pipe(map((e): MessageEvent => ({ data: e }))),
      heartbeat(),
    );
  }
}
