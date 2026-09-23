import { Body, Controller, Delete, Get, Inject, Param, Post } from "@nestjs/common";
import type { PromoteDraftBody, SeedBaselinesBody } from "@varys/review-contract";
import { type AuthUser, CurrentUser } from "../auth/current-user.decorator";
import { TestsService } from "./tests.service";

/**
 * The AI-authored Draft review queue and the human-only promote/discard actions
 * (Slice 14). Promotion lives here — in the web-reachable API surface — and is
 * deliberately NOT an MCP/agent tool, so Claude cannot self-promote (ADR 0001).
 */
@Controller("drafts")
export class DraftsController {
  constructor(@Inject(TestsService) private readonly tests: TestsService) {}

  /** The review queue: AI-authored drafts awaiting a human decision, newest first. */
  @Get()
  list() {
    return this.tests.listDrafts();
  }

  /** Full draft detail (per-checkpoint authoring previews) for the promote view. */
  @Get(":id")
  get(@Param("id") id: string) {
    return this.tests.getDraft(id);
  }

  /** Promote a draft into the active corpus (folder + tags + active). Web-UI only. */
  @Post(":id/promote")
  promote(@Param("id") id: string, @Body() body: PromoteDraftBody, @CurrentUser() user: AuthUser) {
    return this.tests.promote(id, body ?? {}, user.email);
  }

  /**
   * Approve an Agent-Driven Draft's authoring captures as the baselines for one environment.
   *
   * Deliberately its own route and not a flag on promote. They are different decisions with
   * different blast radii — promote files a test and makes it eligible to run, this one declares
   * what "correct" means — and a reviewer must be able to do either without the other. Web-UI
   * only, like promote and for the same reason: an agent must not be able to approve its own
   * capture as the standard it will later be judged against.
   */
  @Post(":id/baselines")
  seedBaselines(
    @Param("id") id: string,
    @Body() body: SeedBaselinesBody,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tests.seedBaselinesFromCaptures(id, body ?? ({} as SeedBaselinesBody), user.email);
  }

  /** Discard a draft — reuses the hard-delete path (irreversible). */
  @Delete(":id")
  discard(@Param("id") id: string) {
    return this.tests.delete(id);
  }
}
