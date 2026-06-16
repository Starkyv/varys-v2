import { Body, Controller, Delete, Get, Inject, Param, Post } from "@nestjs/common";
import type { PromoteDraftBody } from "@varys/review-contract";
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

  /** Promote a draft into the active corpus (folder + tags + active). Web-UI only. */
  @Post(":id/promote")
  promote(@Param("id") id: string, @Body() body: PromoteDraftBody) {
    return this.tests.promote(id, body ?? {});
  }

  /** Discard a draft — reuses the hard-delete path (irreversible). */
  @Delete(":id")
  discard(@Param("id") id: string) {
    return this.tests.delete(id);
  }
}
