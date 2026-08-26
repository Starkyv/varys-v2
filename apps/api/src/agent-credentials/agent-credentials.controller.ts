import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import type {
  AgentCredentialSummary,
  CreateAgentCredentialRequest,
  CreatedAgentCredential,
} from "@varys/review-contract";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { AgentCredentialsService } from "./agent-credentials.service";

/**
 * The management surface for Repair Agent credentials (Slice 19, slice 02 / ADR-0005) — provision,
 * list, revoke.
 *
 * Guarded like every other route: an admin provisions machine access from a signed-in browser
 * session. Notably a Repair Agent credential can NOT reach here — it only ever authenticates
 * `/mcp`, so an agent cannot mint itself a second credential or extend its own life.
 *
 * Mounted under the existing `/settings` prefix on purpose: a new top-level prefix would also
 * need adding to the Vite dev proxy and the prod ingress, and this genuinely is a settings screen.
 */
@Controller("settings/agent-credentials")
export class AgentCredentialsController {
  constructor(@Inject(AgentCredentialsService) private readonly credentials: AgentCredentialsService) {}

  @Get()
  list(): Promise<AgentCredentialSummary[]> {
    return this.credentials.list();
  }

  /** Provision one. The response carries the token — the only time it is readable. */
  @Post()
  create(
    @Body() body: CreateAgentCredentialRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<CreatedAgentCredential> {
    return this.credentials.create(body ?? { label: "" }, user?.email ?? "unknown");
  }

  @Post(":id/revoke")
  @HttpCode(200) // mutates an existing credential; creates nothing
  revoke(@Param("id") id: string): Promise<AgentCredentialSummary> {
    return this.credentials.revoke(id);
  }
}
