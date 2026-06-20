import { Inject, Injectable } from "@nestjs/common";
import { appSettings } from "@varys/db";
import type { AuthoringInstructionsView } from "@varys/review-contract";
import { eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { DEFAULT_AUTHORING_INSTRUCTIONS, envOperatorInstructions } from "./authoring-instructions";

/** `app_settings` keys for the two editable layers. */
const BASE_KEY = "authoring_instructions_base";
const ADDITIONAL_KEY = "authoring_instructions_additional";

/**
 * Owns the AI authoring instructions (the MCP `initialize` prompt), in two runtime-editable layers
 * stored in `app_settings` and edited from the Author page:
 *  - BASE — the foundational prompt; rarely changed. Falls back to {@link DEFAULT_AUTHORING_INSTRUCTIONS}
 *    when no override is stored (storing text equal to the default is treated as "use default").
 *  - ADDITIONAL — team guidance appended under its own heading; edited often. An env value
 *    (VARYS_AUTHORING_INSTRUCTIONS[_FILE]) locks this layer (deployment override), ignoring the DB.
 *
 * The MCP controller calls {@link resolve} per connect, so edits take effect on the next connect —
 * no restart.
 */
@Injectable()
export class AuthoringInstructionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async get(key: string): Promise<string | null> {
    const rows = await this.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    return rows[0]?.value ?? null;
  }

  private async upsert(key: string, value: string): Promise<void> {
    await this.db
      .insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  }

  private async clear(key: string): Promise<void> {
    await this.db.delete(appSettings).where(eq(appSettings.key, key));
  }

  /** The effective base (stored override, else the baked default). */
  private async base(): Promise<{ text: string; usingDefault: boolean }> {
    const stored = await this.get(BASE_KEY);
    return { text: stored ?? DEFAULT_AUTHORING_INSTRUCTIONS, usingDefault: stored === null };
  }

  /** The effective additional layer: env lock wins, else the stored value, else empty. */
  private async additional(): Promise<{ text: string; lockedByEnv: boolean }> {
    const env = envOperatorInstructions();
    if (env !== null) return { text: env, lockedByEnv: true };
    return { text: (await this.get(ADDITIONAL_KEY)) ?? "", lockedByEnv: false };
  }

  /** The full instructions string for MCP `initialize`: base, plus additional under its heading. */
  async resolve(): Promise<string> {
    const base = (await this.base()).text;
    const additional = (await this.additional()).text.trim();
    return additional ? `${base}\n\n## Additional instructions\n\n${additional}` : base;
  }

  /** What the Author-page editor renders. */
  async view(): Promise<AuthoringInstructionsView> {
    const base = await this.base();
    const additional = await this.additional();
    return {
      base: base.text,
      baseUsingDefault: base.usingDefault,
      baseDefault: DEFAULT_AUTHORING_INSTRUCTIONS,
      additional: additional.text,
      additionalLockedByEnv: additional.lockedByEnv,
    };
  }

  /** Save the base layer. Empty, or text equal to the default, clears the override (→ use default). */
  async saveBase(text: string): Promise<void> {
    const trimmed = (text ?? "").trim();
    if (!trimmed || trimmed === DEFAULT_AUTHORING_INSTRUCTIONS.trim()) return this.clear(BASE_KEY);
    await this.upsert(BASE_KEY, trimmed);
  }

  /** Save the additional layer. Empty clears it. No-op while env-locked (the env value wins). */
  async saveAdditional(text: string): Promise<void> {
    if (envOperatorInstructions() !== null) return;
    const trimmed = (text ?? "").trim();
    if (!trimmed) return this.clear(ADDITIONAL_KEY);
    await this.upsert(ADDITIONAL_KEY, trimmed);
  }
}
