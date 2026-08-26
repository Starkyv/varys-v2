import { Module } from "@nestjs/common";
import { AgentCredentialsController } from "./agent-credentials.controller";
import { AgentCredentialsService } from "./agent-credentials.service";

@Module({
  controllers: [AgentCredentialsController],
  providers: [AgentCredentialsService],
  // Exported so `McpAuthService` can resolve a presented token into an `agent:…` principal —
  // the second issuer of ADR-0005.
  exports: [AgentCredentialsService],
})
export class AgentCredentialsModule {}
