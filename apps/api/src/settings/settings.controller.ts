import { Body, Controller, Get, HttpCode, Inject, Post, Put } from "@nestjs/common";
import type {
  ImageComparisonSettings,
  JudgeSettingsPatch,
  JudgeSettingsView,
  SlackSettingsPatch,
  SlackSettingsView,
} from "@varys/review-contract";
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

  // The LLM judge config for context checkpoints. GET is masked (never returns the API key).
  @Get("judge")
  getJudge(): Promise<JudgeSettingsView> {
    return this.settings.getJudge();
  }

  @Put("judge")
  putJudge(@Body() body: JudgeSettingsPatch): Promise<JudgeSettingsView> {
    return this.settings.saveJudge(body ?? {});
  }

  // Slack run-completion notifications. GET is masked (never returns the bot token). POST /test
  // posts a message with the stored credentials so the user can verify before enabling.
  @Get("slack")
  getSlack(): Promise<SlackSettingsView> {
    return this.settings.getSlack();
  }

  @Put("slack")
  putSlack(@Body() body: SlackSettingsPatch): Promise<SlackSettingsView> {
    return this.settings.saveSlack(body ?? {});
  }

  @Post("slack/test")
  @HttpCode(200)
  testSlack(): Promise<{ ok: true }> {
    return this.settings.sendSlackTest();
  }
}
