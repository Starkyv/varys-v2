import { buildJudge, createJudgeFromEnv, type JudgeProvider, type JudgeProviderName } from "@varys/judge-engine";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/db.module";
import { appSettings } from "../db/schema";

/**
 * Where the repair-justification gate gets its judge (Slice 19, slice 05).
 *
 * The same judge a `context` checkpoint uses — configured once in Configurations, falling back to
 * `VARYS_JUDGE_*` in the environment — reached through a provider token so an E2E can script the
 * verdict (and the transport error) without a network. Resolved PER CALL, like the worker does, so
 * a Configurations edit takes effect on the next repair without a redeploy.
 *
 * `undefined` means NO judge is configured. The gate must then refuse the repair, not wave it
 * through: an unvalidated repair is exactly what this slice exists to prevent.
 */
export interface JudgeSource {
  resolve(): Promise<JudgeProvider | undefined>;
}

export const JUDGE_SOURCE = "REPAIR_JUDGE_SOURCE";

/** The same `app_settings` keys the worker reads — one configuration, two callers. */
const JUDGE_SETTINGS_KEYS = {
  provider: "judge_provider",
  apiKey: "judge_api_key",
  model: "judge_model",
  baseUrl: "judge_base_url",
  temperature: "judge_temperature",
} as const;

export function createDbJudgeSource(db: Db): JudgeSource {
  return {
    async resolve(): Promise<JudgeProvider | undefined> {
      const rows = await db
        .select({ key: appSettings.key, value: appSettings.value })
        .from(appSettings)
        .where(inArray(appSettings.key, Object.values(JUDGE_SETTINGS_KEYS)));
      const v = new Map(rows.map((r) => [r.key, r.value]));
      const temperature = Number(v.get(JUDGE_SETTINGS_KEYS.temperature));
      const fromDb = buildJudge({
        provider: v.get(JUDGE_SETTINGS_KEYS.provider) as JudgeProviderName | undefined,
        apiKey: v.get(JUDGE_SETTINGS_KEYS.apiKey) ?? "",
        model: v.get(JUDGE_SETTINGS_KEYS.model) ?? "",
        baseUrl: v.get(JUDGE_SETTINGS_KEYS.baseUrl) || undefined,
        temperature: Number.isFinite(temperature) ? temperature : undefined,
      });
      return fromDb ?? createJudgeFromEnv();
    },
  };
}
