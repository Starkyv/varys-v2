import type { IncomingHttpHeaders } from "node:http";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import { AGENT_TOKEN_PREFIX, AgentCredentialsService } from "../agent-credentials/agent-credentials.service";
import { getAuth } from "../auth/auth";

/** Which issuer produced a principal (ADR-0005). `user` is a human who completed the browser
 *  OAuth leg; `agent` is an unattended drainer presenting a Repair Agent credential. The kind is
 *  what the tool surface is gated on — an agent is scoped, not trusted. */
export type McpPrincipalKind = "user" | "agent";

/** The identity behind one authenticated `/mcp` request. `id` is the isolation key
 *  (stable per user, or `agent:<credentialId>` for a Repair Agent); `email` is what gets written
 *  as a draft's `createdBy`. */
export interface McpPrincipal {
  id: string;
  email: string;
  name: string;
  /** The OAuth client the token was issued to — the user's Claude Code install. Empty for an
   *  agent principal, which has no OAuth client. */
  clientId: string;
  kind: McpPrincipalKind;
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
 *
 * ADR-0005 adds a SECOND ISSUER here for unattended machine access: a bearer token carrying the
 * Repair Agent prefix is resolved against `agent_credentials` instead, yielding an `agent:…`
 * principal. It is not an exemption — it produces a real `McpPrincipal`, so every downstream
 * ownership check and attribution write is unchanged — and the human OAuth path is untouched by
 * it, because the token's prefix decides which issuer runs before either is consulted.
 */
@Injectable()
export class McpAuthService {
  private readonly log = new Logger(McpAuthService.name);

  constructor(
    @Inject(AgentCredentialsService) private readonly agentCredentials: AgentCredentialsService,
  ) {}

  /**
   * The authenticated principal for a request, or `McpUnauthorized` if the token is
   * missing, unknown, or expired. Never falls back to an anonymous identity — an
   * unauthenticated `/mcp` request must not be able to see or drive anyone's sessions.
   */
  async principal(headers: IncomingHttpHeaders): Promise<McpPrincipal> {
    const bearer = readBearer(headers);
    if (bearer?.startsWith(AGENT_TOKEN_PREFIX)) return this.agentPrincipal(bearer);

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
      kind: "user",
    };
  }

  /**
   * The Repair Agent issuer (ADR-0005). An unknown, malformed, revoked or expired credential
   * throws the SAME `McpUnauthorized` an unknown OAuth token does — so the 401 an attacker sees
   * is identical either way and agent tokens cannot be probed for.
   *
   * The label lands in `email`/`name` because those are what downstream writes attribute to:
   * a repaired version reads `Repair Agent "nightly-drainer"`, which is more truthful than
   * borrowing a human's identity.
   */
  private async agentPrincipal(token: string): Promise<McpPrincipal> {
    const credential = await this.agentCredentials.resolve(token);
    if (!credential) {
      throw new McpUnauthorized("Authentication required");
    }
    const label = `Repair Agent "${credential.label}"`;
    return {
      id: `agent:${credential.id}`,
      email: label,
      name: label,
      clientId: "",
      kind: "agent",
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

/** The raw bearer token on a request, or null. Only used to pick the ISSUER — each issuer
 *  validates the token itself. */
function readBearer(headers: IncomingHttpHeaders): string | null {
  const raw = headers.authorization; // node lowercases incoming header names
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}
