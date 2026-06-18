import { Controller, Get, Inject, type MessageEvent, Param, Sse } from "@nestjs/common";
import type { AuthoringFrame, AuthoringSessionSummary, McpStatus } from "@varys/review-contract";
import { concat, EMPTY, filter, interval, map, merge, type Observable, of } from "rxjs";
import { AuthoringSessionService } from "./authoring-session.service";
import { McpStatusService } from "./mcp-status.service";

/**
 * Live preview of Authoring Sessions in the Varys web app (Slice 15 — Author with AI).
 *
 * Authenticated, deliberately UNLIKE the public `/mcp`: this drives a signed-in human's view of
 * a server-side browser, so it sits behind the global auth guard (no `@Public`). The frame
 * stream is a human-only channel — the model only perceives a screenshot when it itself calls
 * `observe(screenshot:true)`, so watching here costs no inference.
 */
@Controller("authoring")
export class LivePreviewController {
  constructor(
    @Inject(AuthoringSessionService) private readonly authoring: AuthoringSessionService,
    @Inject(McpStatusService) private readonly mcpStatus: McpStatusService,
  ) {}

  /** Whether Claude Code has recently driven the MCP server (activity-based — the MCP transport is
   *  stateless HTTP, so this reflects recent requests, not a held connection). */
  @Get("mcp-status")
  status(): McpStatus {
    return this.mcpStatus.status();
  }

  /** The active Authoring Sessions a signed-in user can choose to watch. */
  @Get("sessions")
  listSessions(): Promise<AuthoringSessionSummary[]> {
    return this.authoring.listSessions();
  }

  /**
   * SSE stream of live frames for one Authoring Session: the current frame first (so a viewer
   * that joins mid-session paints immediately), then every subsequent frame. A periodic
   * heartbeat (a `ping` event the client ignores) keeps idle proxies from dropping the stream.
   */
  @Sse("sessions/:id/stream")
  stream(@Param("id") id: string): Observable<MessageEvent> {
    const current = this.authoring.latestFrame(id);
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
