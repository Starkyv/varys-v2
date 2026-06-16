import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

/** The signed-in user, as attached to the request by `AuthGuard`. */
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

/**
 * Inject the current user (set by the global `AuthGuard`) into a handler. Only valid on
 * guarded routes — which is every route except the `@Public()` allowlist — so the user
 * is always present there. Used to attribute audited writes (who approved / who edited).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
    return ctx.switchToHttp().getRequest<{ user?: AuthUser }>().user;
  },
);
