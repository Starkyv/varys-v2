import { SetMetadata } from "@nestjs/common";

/** Reflector key marking a route (or whole controller) as exempt from the auth guard. */
export const IS_PUBLIC_KEY = "varys:isPublic";

/**
 * Mark a controller or handler as reachable WITHOUT a session — the guard's allowlist.
 * Used for `/health` (liveness) and `/mcp` (Claude Code authoring; unauthenticated this
 * slice per the locked decision). The better-auth routes (`/api/auth/*`) and the
 * self-hosted `/trace-viewer` assets bypass the guard already — they're served by
 * Express middleware mounted ahead of Nest's router, not Nest route handlers.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
