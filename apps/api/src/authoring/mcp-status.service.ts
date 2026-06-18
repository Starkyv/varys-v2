import { Injectable } from "@nestjs/common";
import type { McpStatus } from "@varys/review-contract";

/** A request within this window counts as "active". The MCP transport is stateless HTTP, so this
 *  is the best available proxy for "Claude Code is connected and driving right now". */
const ACTIVE_WINDOW_MS = 30_000;

/**
 * Tracks recent MCP activity so the web app can show whether Claude Code is driving the authoring
 * server (Slice 15 — Author with AI). `McpController` calls `touch()` on every JSON-RPC request;
 * the live-preview controller reads `status()`. Process-local, like the sessions themselves.
 */
@Injectable()
export class McpStatusService {
  private lastSeenAt: number | null = null;

  /** Record that an MCP request was just received. */
  touch(): void {
    this.lastSeenAt = Date.now();
  }

  status(): McpStatus {
    return {
      lastSeenAt: this.lastSeenAt,
      connected: this.lastSeenAt != null && Date.now() - this.lastSeenAt < ACTIVE_WINDOW_MS,
    };
  }
}
