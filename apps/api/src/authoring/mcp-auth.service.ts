import type { IncomingHttpHeaders } from "node:http";
import { Injectable, Logger } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "../auth/auth";

/** The identity behind one authenticated `/mcp` request. `id` is the isolation key
 *  (stable per user); `email` is what gets written as a draft's `createdBy`. */
export interface McpPrincipal {
  id: string;
  email: string;
  name: string;
  /** The OAuth client the token was issued to — the user's Claude Code install. */
  clientId: string;
}

/** Thrown when a `/mcp` request carries no usable bearer token. The controller turns this
 *  into a 401 + `WWW-Authenticate`, which is the signal that starts Claude Code's OAuth flow. */
export class McpUnauthorized extends Error {}

/**
 * Resolves the OAuth bearer token on an MCP request to the Varys user who authorized it
 * (Slice 16 — per-user MCP auth).
 *
 * `/mcp` can't use the cookie guard: Claude Code is a separate process with no browser
 * cookie. It instead completes an OAuth 2.1 authorization-code + PKCE flow against
 * better-auth's `mcp` plugin (see `../auth/auth.ts`) and sends `Authorization: Bearer …`
 * on every JSON-RPC request. `getMcpSession` validates the token against
 * `oauthAccessToken` (existence + expiry) and yields its `userId`, which we resolve to
 * the user record so callers get an identity, not just an id.
 */
@Injectable()
export class McpAuthService {
  private readonly log = new Logger(McpAuthService.name);

  /**
   * The authenticated principal for a request, or `McpUnauthorized` if the token is
   * missing, unknown, or expired. Never falls back to an anonymous identity — an
   * unauthenticated `/mcp` request must not be able to see or drive anyone's sessions.
   */
  async principal(headers: IncomingHttpHeaders): Promise<McpPrincipal> {
    const auth = getAuth();
    const token = await auth.api
      .getMcpSession({ headers: fromNodeHeaders(headers) })
      .catch((err: unknown) => {
        this.log.warn(`MCP token lookup failed: ${(err as Error).message}`);
        return null;
      });
    if (!token?.userId) {
      throw new McpUnauthorized("Authentication required");
    }

    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.findUserById(token.userId);
    if (!user) {
      // The token outlived its user (account deleted) — treat it as invalid, not as a
      // ghost identity that could still open sessions.
      throw new McpUnauthorized("Authentication required");
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name ?? user.email,
      clientId: String(token.clientId ?? ""),
    };
  }

  /**
   * The `WWW-Authenticate` value for a 401. Pointing at the protected-resource metadata
   * (RFC 9728) is what tells an MCP client WHERE to authenticate, so Claude Code can
   * discover the authorization server and register itself without manual configuration.
   */
  challenge(): string {
    const base = process.env.BETTER_AUTH_URL ?? "http://localhost:5174";
    return `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
  }
}
