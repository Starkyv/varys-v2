import { Module } from "@nestjs/common";
import { TestsModule } from "../tests/tests.module";
import { AuthoringSessionService } from "./authoring-session.service";
import { McpController } from "./mcp.controller";

@Module({
  // TestsModule exports TestsService — the authoring session persists its result as a
  // Draft through it (so all tests/test_versions writes stay in one place).
  imports: [TestsModule],
  controllers: [McpController],
  providers: [AuthoringSessionService],
})
export class AuthoringModule {}
