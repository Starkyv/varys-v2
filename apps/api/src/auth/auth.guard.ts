import type { IncomingHttpHeaders } from "node:http";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "./auth";
import { IS_PUBLIC_KEY } from "./public.decorator";

/** The slice of the Express request the guard touches — avoids depending on express
 *  types directly (only available transitively; the MCP controller dodges them too). */
interface GuardRequest {
  headers: IncomingHttpHeaders;
  user?: unknown;
  session?: unknown;
}

/**
 * The global auth gate (DESIGN §11): the API is deny-by-default. Every request must
 * carry a valid better-auth session cookie; the resolved user is attached to the
 * request (consumed by audit wiring in Issue 4). Routes/controllers marked `@Public()`
 * are exempt (`/health`, `/mcp`).
 *
 * Registered as an `APP_GUARD` in `AuthModule`. `@Inject(Reflector)` is explicit because
 * esbuild emits no decorator metadata in this repo (implicit DI silently fails to boot).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<GuardRequest>();
    const session = await getAuth().api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      throw new UnauthorizedException("Authentication required");
    }

    // Make the identity available to handlers (audit attribution lands in Issue 4).
    req.user = session.user;
    req.session = session.session;
    return true;
  }
}
