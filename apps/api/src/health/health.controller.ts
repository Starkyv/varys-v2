import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";

/** Liveness probe — public (no session required), so health checks work pre-auth. */
@Public()
@Controller("health")
export class HealthController {
  @Get()
  check() {
    return { status: "ok" };
  }
}
