import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthConfigController } from "./auth-config.controller";
import { AuthGuard } from "./auth.guard";
import { McpDiscoveryController } from "./mcp-discovery.controller";

/**
 * Registers the global auth gate. `APP_GUARD` applies `AuthGuard` to every Nest route;
 * the deny-by-default policy + the `@Public()` allowlist live in the guard. Also serves
 * the public `GET /auth-config` (which sign-in methods are enabled) and the public
 * OAuth discovery documents MCP clients probe at the origin root.
 */
@Module({
  controllers: [AuthConfigController, McpDiscoveryController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
