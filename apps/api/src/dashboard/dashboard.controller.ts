import { Controller, Get, Inject } from "@nestjs/common";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  // Explicit token so DI works without emitted decorator metadata (tsx/esbuild
  // doesn't emit design:paramtypes — implicit injection silently fails to boot).
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  // The whole dashboard read-model in one read (KPI summary + recent-runs feed).
  @Get()
  get() {
    return this.dashboard.getDashboard();
  }
}
