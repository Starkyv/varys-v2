import { Module } from "@nestjs/common";
import { RunsModule } from "../runs/runs.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";

@Module({
  // RunsModule exports RunsService — the dashboard reuses its Runs-history list
  // for the recent-runs feed instead of duplicating the query.
  imports: [RunsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
