import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { appSettings } from "@varys/db";
import { sendSlackMessage, SLACK_SETTINGS_KEYS } from "@varys/notify";
import {
  DEFAULT_IMAGE_COMPARISON_SETTINGS,
  type ImageComparisonSettings,
  type JudgeProviderName,
  type JudgeSettingsPatch,
  type JudgeSettingsView,
  type SlackSettingsPatch,
  type SlackSettingsView,
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

  // ── Slack notifications ───────────────────────────────────────────────────────────────────
  // The worker (@varys/notify) reads these same `app_settings` keys after every run, so an edit
  // here takes effect on the next completion — no restart. GET is masked (never returns the token).

  /** The effective Slack config, token masked. */
  async getSlack(): Promise<SlackSettingsView> {
    const rows = await this.db
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(inArray(appSettings.key, Object.values(SLACK_SETTINGS_KEYS)));
    const v = new Map(rows.map((r) => [r.key, r.value]));
    const token = v.get(SLACK_SETTINGS_KEYS.token) ?? "";
    return {
      // Per-source gates default ON (absent or "true"); only an explicit "false" mutes. There is no
      // master switch — all-off means no notifications.
      notifyManual: v.get(SLACK_SETTINGS_KEYS.notifyManual) !== "false",
      notifySchedule: v.get(SLACK_SETTINGS_KEYS.notifySchedule) !== "false",
      notifySuite: v.get(SLACK_SETTINGS_KEYS.notifySuite) !== "false",
      attachPdf: v.get(SLACK_SETTINGS_KEYS.attachPdf) === "true",
      channel: v.get(SLACK_SETTINGS_KEYS.channel) ?? "",
      baseUrl: v.get(SLACK_SETTINGS_KEYS.baseUrl) || null,
      tokenSet: token.length > 0,
      tokenHint: token.length >= 4 ? token.slice(-4) : token.length > 0 ? "••••" : null,
    };
  }

  /** Upsert whichever Slack fields are present; a blank/absent `token` never clears the stored one
   *  (so re-saving from the masked view keeps it). Returns the new masked view. */
  async saveSlack(patch: SlackSettingsPatch): Promise<SlackSettingsView> {
    const writes: { key: string; value: string }[] = [];
    if (typeof patch.attachPdf === "boolean") {
      writes.push({ key: SLACK_SETTINGS_KEYS.attachPdf, value: String(patch.attachPdf) });
    }
    if (typeof patch.notifyManual === "boolean") {
      writes.push({ key: SLACK_SETTINGS_KEYS.notifyManual, value: String(patch.notifyManual) });
    }
    if (typeof patch.notifySchedule === "boolean") {
      writes.push({ key: SLACK_SETTINGS_KEYS.notifySchedule, value: String(patch.notifySchedule) });
    }
    if (typeof patch.notifySuite === "boolean") {
      writes.push({ key: SLACK_SETTINGS_KEYS.notifySuite, value: String(patch.notifySuite) });
    }
    if (typeof patch.channel === "string") {
      writes.push({ key: SLACK_SETTINGS_KEYS.channel, value: patch.channel.trim() });
    }
    if (typeof patch.baseUrl === "string") {
      writes.push({ key: SLACK_SETTINGS_KEYS.baseUrl, value: patch.baseUrl.trim() });
    }
    if (typeof patch.token === "string" && patch.token.trim().length > 0) {
      writes.push({ key: SLACK_SETTINGS_KEYS.token, value: patch.token.trim() });
    }
    for (const w of writes) {
      await this.db
        .insert(appSettings)
        .values(w)
        .onConflictDoUpdate({ target: appSettings.key, set: { value: w.value, updatedAt: new Date() } });
    }
    return this.getSlack();
  }

  /** Post a test message using the STORED token + channel (regardless of the enabled toggle, so a
   *  user can verify credentials before switching notifications on). 400 if unconfigured. */
  async sendSlackTest(): Promise<{ ok: true }> {
    const rows = await this.db
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(inArray(appSettings.key, Object.values(SLACK_SETTINGS_KEYS)));
    const v = new Map(rows.map((r) => [r.key, r.value]));
    const token = (v.get(SLACK_SETTINGS_KEYS.token) ?? "").trim();
    const channel = (v.get(SLACK_SETTINGS_KEYS.channel) ?? "").trim();
    if (!token) throw new BadRequestException("Add a Slack bot token first.");
    if (!channel) throw new BadRequestException("Add a Slack channel first.");
    const res = await sendSlackMessage(
      {
        token,
        channel,
        baseUrl: (v.get(SLACK_SETTINGS_KEYS.baseUrl) ?? "").trim(),
        attachPdf: false,
        notifyManual: true,
        notifySchedule: true,
        notifySuite: true,
      },
      {
        text: "✅ Varys is connected",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "*✅ Varys is connected* — run notifications will post here." },
          },
        ],
      },
    );
    if (!res.ok) throw new BadRequestException(`Slack rejected the test message: ${res.error}`);
    return { ok: true };
  }
}
