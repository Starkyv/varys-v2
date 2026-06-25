import { Module } from "@nestjs/common";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  // Exported so RunsService can apply the global per-pixel default during live mask/threshold
  // re-evaluation — keeping the in-viewer score consistent with what the runner computes on a
  // real replay.
  exports: [SettingsService],
})
export class SettingsModule {}
