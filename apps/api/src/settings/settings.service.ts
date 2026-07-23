import { Inject, Injectable } from "@nestjs/common";
import { appSettings } from "@varys/db";
import {
  DEFAULT_IMAGE_COMPARISON_SETTINGS,
  type ImageComparisonSettings,
  type JudgeProviderName,
  type JudgeSettingsPatch,
  type JudgeSettingsView,
} from "@varys/review-contract";
import { inArray } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

/** `app_settings` keys for the global image-comparison defaults. Kept in sync with the runner
 *  (packages/runner), which reads these same keys to apply the defaults on every replay. */
const RATIO_KEY = "image_comparison_ratio";
const PER_PIXEL_KEY = "image_comparison_per_pixel";

/** `app_settings` keys for the LLM judge config. Kept in sync with the runner's
 *  `JUDGE_SETTINGS_KEYS`, which reads these to build the judge per run. */
const JUDGE_PROVIDER_KEY = "judge_provider";
const JUDGE_MODEL_KEY = "judge_model";
const JUDGE_API_KEY_KEY = "judge_api_key";
const JUDGE_BASE_URL_KEY = "judge_base_url";
const JUDGE_TEMPERATURE_KEY = "judge_temperature";
const JUDGE_DEFAULT_PROMPT_KEY = "judge_default_prompt";

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

  /** The judge config for the Configurations page — MASKED: the stored API key is never returned,
   *  only whether it's set and its last-4 hint. */
  async getJudge(): Promise<JudgeSettingsView> {
    const rows = await this.db
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(
        inArray(appSettings.key, [
          JUDGE_PROVIDER_KEY,
          JUDGE_MODEL_KEY,
          JUDGE_API_KEY_KEY,
          JUDGE_BASE_URL_KEY,
          JUDGE_DEFAULT_PROMPT_KEY,
        ]),
      );
    const v = new Map(rows.map((r) => [r.key, r.value]));
    const key = v.get(JUDGE_API_KEY_KEY) ?? "";
    return {
      provider: (v.get(JUDGE_PROVIDER_KEY) as JudgeProviderName) ?? "gemini",
      model: v.get(JUDGE_MODEL_KEY) ?? "",
      baseUrl: v.get(JUDGE_BASE_URL_KEY) || null,
      apiKeySet: key.length > 0,
      apiKeyHint: key.length >= 4 ? key.slice(-4) : key.length > 0 ? "••••" : null,
      defaultPrompt: v.get(JUDGE_DEFAULT_PROMPT_KEY) ?? "",
    };
  }

  /** Upsert whichever judge fields are present; an absent field is untouched. A non-empty `apiKey`
   *  replaces the stored key; an omitted/empty one leaves the existing key in place (so re-saving
   *  the masked form doesn't wipe the key). Returns the new masked view. */
  async saveJudge(patch: JudgeSettingsPatch): Promise<JudgeSettingsView> {
    const writes: { key: string; value: string }[] = [];
    if (patch.provider) writes.push({ key: JUDGE_PROVIDER_KEY, value: patch.provider });
    if (typeof patch.model === "string") writes.push({ key: JUDGE_MODEL_KEY, value: patch.model.trim() });
    if (typeof patch.baseUrl === "string") writes.push({ key: JUDGE_BASE_URL_KEY, value: patch.baseUrl.trim() });
    if (typeof patch.temperature === "number" && Number.isFinite(patch.temperature)) {
      writes.push({ key: JUDGE_TEMPERATURE_KEY, value: String(patch.temperature) });
    }
    if (typeof patch.defaultPrompt === "string") {
      writes.push({ key: JUDGE_DEFAULT_PROMPT_KEY, value: patch.defaultPrompt });
    }
    // Only overwrite the key when a real one is supplied — never blank it from a masked re-save.
    if (typeof patch.apiKey === "string" && patch.apiKey.trim().length > 0) {
      writes.push({ key: JUDGE_API_KEY_KEY, value: patch.apiKey.trim() });
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
    return this.getJudge();
  }
}
