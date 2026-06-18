import { Body, Controller, Get, Headers, Inject, type MessageEvent, Param, Post, Sse } from "@nestjs/common";
import type { BridgeChatState, BridgeHelperEvent, BridgePairResult } from "@varys/review-contract";
import { interval, map, merge, type Observable } from "rxjs";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { Public } from "../auth/public.decorator";
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
 *  - web side (`POST /`, `:chatId`, `:chatId/prompt`, `:chatId/stream`) — cookie-authenticated and
 *    owner-scoped (the controller passes the better-auth user id to the service).
 */
@Controller("authoring/bridge")
export class BridgeController {
  constructor(@Inject(BridgeService) private readonly bridge: BridgeService) {}

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

  @Post()
  create(@CurrentUser() user: AuthUser): BridgeChatState {
    return this.bridge.create(user.id);
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
