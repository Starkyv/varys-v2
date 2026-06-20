import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import type { AuthoringInstructionsView } from "@varys/review-contract";
import { AuthoringInstructionsService } from "./authoring-instructions.service";

/**
 * Read / edit the AI authoring instructions (the MCP `initialize` prompt) from the Author page.
 * Authenticated (no `@Public`, unlike `/mcp`): any signed-in Varys user can change them, and the
 * edit takes effect the next time Claude Code connects. PUT updates whichever layer(s) are present
 * in the body (`base` and/or `additional`) — an absent field is left untouched. Lives under the
 * existing `/authoring` prefix, so no new top-level route is introduced.
 */
@Controller("authoring/instructions")
export class AuthoringInstructionsController {
  constructor(
    @Inject(AuthoringInstructionsService) private readonly instructions: AuthoringInstructionsService,
  ) {}

  @Get()
  get(): Promise<AuthoringInstructionsView> {
    return this.instructions.view();
  }

  @Put()
  async put(@Body() body: { base?: string; additional?: string }): Promise<{ ok: true }> {
    if (typeof body?.base === "string") await this.instructions.saveBase(body.base);
    if (typeof body?.additional === "string") await this.instructions.saveAdditional(body.additional);
    return { ok: true };
  }
}
