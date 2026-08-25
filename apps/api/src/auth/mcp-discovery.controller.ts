import { Controller, Get } from "@nestjs/common";
import { getAuth } from "./auth";
import { Public } from "./public.decorator";

/**
 * OAuth discovery documents for the MCP server (Slice 16 — per-user MCP auth).
 *
 * better-auth serves these under its own base path (`/api/auth/.well-known/…`), but MCP
 * clients probe the ROOT of the origin they connect to — so these thin, public routes
 * re-serve the same metadata from `/`. Without them Claude Code can't discover that
 * `/mcp` is OAuth-protected and just reports a 401.
 *
 *  - `oauth-protected-resource` (RFC 9728): what `/mcp` is and which authorization server
 *    guards it. Also served with a `/mcp` suffix, the resource-specific form newer clients
 *    request first.
 *  - `oauth-authorization-server` (RFC 8414): the authorize / token / register endpoints,
 *    which is how Claude Code self-registers (DCR) and runs the PKCE flow.
 */
@Public()
@Controller(".well-known")
export class McpDiscoveryController {
  @Get("oauth-protected-resource")
  protectedResource(): Promise<unknown> {
    return getAuth().api.getMCPProtectedResource();
  }

  /** RFC 9728 §3.1 also allows the resource path to be appended to the well-known URL. */
  @Get("oauth-protected-resource/mcp")
  protectedResourceForMcp(): Promise<unknown> {
    return getAuth().api.getMCPProtectedResource();
  }

  @Get("oauth-authorization-server")
  authorizationServer(): Promise<unknown> {
    return getAuth().api.getMcpOAuthConfig();
  }
}
