import { Controller, Get, Inject, type MessageEvent, Param, Sse } from "@nestjs/common";
import type { AuthoringFrame, AuthoringSessionSummary, McpStatus } from "@varys/review-contract";
import { concat, EMPTY, filter, interval, map, merge, type Observable, of } from "rxjs";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { AuthoringSessionService } from "./authoring-session.service";
import { McpStatusService } from "./mcp-status.service";

/**
 * Live preview of Authoring Sessions in the Varys web app (Slice 15 — Author with AI).
 *
 * Cookie-authenticated (no `@Public`), unlike `/mcp`'s bearer tokens: this drives a signed-in
 * human's view of a server-side browser. The frame stream is a human-only channel — the model
 * only perceives a screenshot when it itself calls `observe(screenshot:true)`, so watching here
 * costs no inference.
 *
 * Slice 16 — every route is owner-scoped to the signed-in user: you see the status of your OWN
 * Claude Code, list your OWN sessions, and can only stream a session you opened. The two
 * identities line up because the MCP bearer token resolves to the same better-auth user as this
 * cookie.
 */
@Controller("authoring")
export class LivePreviewController {
  constructor(
    @Inject(AuthoringSessionService) private readonly authoring: AuthoringSessionService,
    @Inject(McpStatusService) private readonly mcpStatus: McpStatusService,
  ) {}

  /** Whether THIS user's Claude Code has recently driven the MCP server (activity-based — the
   *  MCP transport is stateless HTTP, so this reflects recent requests, not a held connection). */
  @Get("mcp-status")
  status(@CurrentUser() user: AuthUser): McpStatus {
    return this.mcpStatus.status(user.id);
  }

  /** The signed-in user's own active Authoring Sessions, to choose one to watch. */
  @Get("sessions")
  listSessions(@CurrentUser() user: AuthUser): Promise<AuthoringSessionSummary[]> {
    return this.authoring.listSessions(user.id);
  }

  /**
   * SSE stream of live frames for one Authoring Session: the current frame first (so a viewer
   * that joins mid-session paints immediately), then every subsequent frame. A periodic
   * heartbeat (a `ping` event the client ignores) keeps idle proxies from dropping the stream.
   */
  @Sse("sessions/:id/stream")
  stream(@Param("id") id: string, @CurrentUser() user: AuthUser): Observable<MessageEvent> {
    // Owner check up front: a non-owner gets the same not-found as an unknown id, and the
    // frame/draft filters below are further pinned to sessions this user owns.
    this.authoring.assertOwner(id, user.id);
    const current = this.authoring.latestFrame(id, user.id);
    const seed: Observable<MessageEvent> = current ? of({ data: current }) : EMPTY;
    const frames = this.authoring.liveFrames$().pipe(
      filter((f: AuthoringFrame) => f.sessionId === id),
      map((f): MessageEvent => ({ data: f })),
    );
    // A terminal "draft" event when the session finishes — surfaced as a named SSE event the
    // web listens for separately (so it can hand off to the review queue).
    const drafts = this.authoring.sessionEvents$().pipe(
      filter((e) => e.sessionId === id),
      map((e): MessageEvent => ({ data: e, type: "draft" })),
    );
    const heartbeat = interval(15_000).pipe(map((): MessageEvent => ({ data: "ping", type: "ping" })));
    return concat(seed, merge(frames, drafts, heartbeat));
  }
}
