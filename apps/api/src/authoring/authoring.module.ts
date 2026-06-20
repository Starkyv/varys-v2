import { Module } from "@nestjs/common";
import { TestsModule } from "../tests/tests.module";
import { AuthoringInstructionsController } from "./authoring-instructions.controller";
import { AuthoringInstructionsService } from "./authoring-instructions.service";
import { AuthoringSessionService } from "./authoring-session.service";
import { BridgeController } from "./bridge.controller";
import { BridgeService } from "./bridge.service";
import { LivePreviewController } from "./live-preview.controller";
import { McpController } from "./mcp.controller";
import { McpStatusService } from "./mcp-status.service";

@Module({
  // TestsModule exports TestsService — the authoring session persists its result as a
  // Draft through it (so all tests/test_versions writes stay in one place).
  imports: [TestsModule],
  // McpController is the public Claude-Code transport; LivePreviewController is the
  // authenticated in-product live-preview surface (Slice 15); BridgeController is the
  // in-product relay that links a user's Bridge Helper to their chat (Slice 15);
  // AuthoringInstructionsController is the authenticated editor for the MCP prompt.
  controllers: [McpController, LivePreviewController, BridgeController, AuthoringInstructionsController],
  providers: [AuthoringSessionService, BridgeService, McpStatusService, AuthoringInstructionsService],
})
export class AuthoringModule {}
