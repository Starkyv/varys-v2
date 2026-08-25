import { Injectable } from "@nestjs/common";
import type { McpStatus } from "@varys/review-contract";

/** A request within this window counts as "active". The MCP transport is stateless HTTP, so this
 *  is the best available proxy for "Claude Code is connected and driving right now". */
const ACTIVE_WINDOW_MS = 30_000;

/** Drop a user's entry once it is this stale, so the map doesn't grow forever in a
 *  long-lived process (any timestamp this old is already reported as disconnected). */
const FORGET_AFTER_MS = 60 * 60 * 1000;

/**
 * Tracks recent MCP activity so the web app can show whether Claude Code is driving the authoring
 * server (Slice 15 — Author with AI). `McpController` calls `touch()` on every JSON-RPC request;
 * the live-preview controller reads `status()`. Process-local, like the sessions themselves.
 *
 * Slice 16 — per-user: activity is keyed by the OAuth-authenticated user id, so a signed-in
 * human sees only THEIR OWN Claude Code as connected. Previously this was a single global
 * timestamp, which made anyone's MCP traffic light up everyone's indicator.
 */
@Injectable()
export class McpStatusService {
  private readonly lastSeenByUser = new Map<string, number>();

  /** Record that an MCP request was just received from this user. */
  touch(userId: string): void {
    const now = Date.now();
    this.lastSeenByUser.set(userId, now);
    for (const [id, at] of this.lastSeenByUser) {
      if (now - at > FORGET_AFTER_MS) this.lastSeenByUser.delete(id);
    }
  }

  /** This user's own MCP activity — never another user's. */
  status(userId: string): McpStatus {
    const lastSeenAt = this.lastSeenByUser.get(userId) ?? null;
    return {
      lastSeenAt,
      connected: lastSeenAt != null && Date.now() - lastSeenAt < ACTIVE_WINDOW_MS,
    };
  }
}
