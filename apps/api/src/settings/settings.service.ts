import { Inject, Injectable } from "@nestjs/common";
import { appSettings } from "@varys/db";
import {
  DEFAULT_IMAGE_COMPARISON_SETTINGS,
  type ImageComparisonSettings,
} from "@varys/review-contract";
import { inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

/** `app_settings` keys for the global image-comparison defaults. Kept in sync with the runner
 *  (packages/runner), which reads these same keys to apply the defaults on every replay. */
const RATIO_KEY = "image_comparison_ratio";
const PER_PIXEL_KEY = "image_comparison_per_pixel";

/** Coerce to a fraction in [0, 1]; anything else (NaN, out of range) falls back. */
function clamp01(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/**
 * Owns the team-wide image-comparison defaults — the two thresholds edited on the Configurations
 * page and applied to every checkpoint diff (a single test can still override the per-checkpoint
 * ratio). Stored as two `app_settings` rows; a missing or unparseable value falls back to
 * {@link DEFAULT_IMAGE_COMPARISON_SETTINGS}. The runner reads the same keys directly, so an edit
 * takes effect on the next run — no restart.
 */
@Injectable()
export class SettingsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The effective defaults — stored values where present, built-in defaults otherwise. */
  async getImageComparison(): Promise<ImageComparisonSettings> {
    const rows = await this.db
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(inArray(appSettings.key, [RATIO_KEY, PER_PIXEL_KEY]));
    const byKey = new Map(rows.map((r) => [r.key, Number(r.value)]));
    return {
      ratio: clamp01(byKey.get(RATIO_KEY) ?? Number.NaN, DEFAULT_IMAGE_COMPARISON_SETTINGS.ratio),
      perPixel: clamp01(
        byKey.get(PER_PIXEL_KEY) ?? Number.NaN,
        DEFAULT_IMAGE_COMPARISON_SETTINGS.perPixel,
      ),
    };
  }

  /** Upsert whichever fields are present (clamped to [0, 1]); an absent field is left untouched.
   *  Returns the new effective settings. */
  async saveImageComparison(
    patch: Partial<ImageComparisonSettings>,
  ): Promise<ImageComparisonSettings> {
    const writes: { key: string; value: string }[] = [];
    if (typeof patch.ratio === "number") {
      writes.push({
        key: RATIO_KEY,
        value: String(clamp01(patch.ratio, DEFAULT_IMAGE_COMPARISON_SETTINGS.ratio)),
      });
    }
    if (typeof patch.perPixel === "number") {
      writes.push({
        key: PER_PIXEL_KEY,
        value: String(clamp01(patch.perPixel, DEFAULT_IMAGE_COMPARISON_SETTINGS.perPixel)),
      });
    }
    for (const w of writes) {
      await this.db
        .insert(appSettings)
        .values(w)
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: w.value, updatedAt: new Date() },
        });
    }
    return this.getImageComparison();
  }
}
