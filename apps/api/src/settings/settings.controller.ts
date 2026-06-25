import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import type { ImageComparisonSettings } from "@varys/review-contract";
import { SettingsService } from "./settings.service";

/**
 * Read / edit the global image-comparison defaults (Configurations page). Authenticated (no
 * `@Public`): any signed-in Varys user can change them, and the edit applies to the next run.
 * PUT accepts a partial body — an omitted field is left untouched — and returns the new effective
 * settings so the client can reconcile against clamping.
 *
 * NOTE: `/settings` is a NEW top-level route — its prefix is mirrored in the Vite dev proxy
 * (apps/web/vite.config.ts) and the prod ingress (deploy/k8s/ingress.yaml).
 */
@Controller("settings")
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get("image-comparison")
  getImageComparison(): Promise<ImageComparisonSettings> {
    return this.settings.getImageComparison();
  }

  @Put("image-comparison")
  putImageComparison(
    @Body() body: Partial<ImageComparisonSettings>,
  ): Promise<ImageComparisonSettings> {
    return this.settings.saveImageComparison(body ?? {});
  }
}
