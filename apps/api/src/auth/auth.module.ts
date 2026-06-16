import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthConfigController } from "./auth-config.controller";
import { AuthGuard } from "./auth.guard";

/**
 * Registers the global auth gate. `APP_GUARD` applies `AuthGuard` to every Nest route;
 * the deny-by-default policy + the `@Public()` allowlist live in the guard. Also serves
 * the public `GET /auth-config` (which sign-in methods are enabled).
 */
@Module({
  controllers: [AuthConfigController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
