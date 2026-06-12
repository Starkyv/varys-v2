import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { environments } from "@varys/db";
import { asc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

export interface CreateEnvironmentInput {
  name: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
}

/**
 * Update body. `values` (when present) REPLACES the whole map (full-map replace is
 * fine for MVP — PRD §B). Secrets are a delta, never echoed: `secrets` sets/overwrites
 * named secrets, `removeSecrets` clears named ones. Omitted fields are left untouched.
 */
export interface UpdateEnvironmentInput {
  name?: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
  removeSecrets?: string[];
}

export interface EnvironmentView {
  id: string;
  name: string;
  values: Record<string, string>;
  /** Secret NAMES only — values are never returned. */
  secretNames: string[];
}

@Injectable()
export class EnvironmentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(input: CreateEnvironmentInput): Promise<{ id: string }> {
    const [env] = await this.db
      .insert(environments)
      .values({
        name: input.name,
        values: input.values ?? {},
        secrets: input.secrets ?? {},
      })
      .returning({ id: environments.id });
    return { id: env.id };
  }

  async getById(id: string): Promise<EnvironmentView> {
    const [row] = await this.db
      .select({
        name: environments.name,
        values: environments.values,
        secrets: environments.secrets,
      })
      .from(environments)
      .where(eq(environments.id, id))
      .limit(1);
    if (!row) throw new NotFoundException(`Environment ${id} not found`);

    return {
      id,
      name: row.name,
      values: (row.values ?? {}) as Record<string, string>,
      secretNames: Object.keys((row.secrets ?? {}) as Record<string, string>),
    };
  }

  /** List every environment (creation order). Secret values are never returned — names only. */
  async list(): Promise<EnvironmentView[]> {
    const rows = await this.db
      .select({
        id: environments.id,
        name: environments.name,
        values: environments.values,
        secrets: environments.secrets,
      })
      .from(environments)
      .orderBy(asc(environments.createdAt));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      values: (row.values ?? {}) as Record<string, string>,
      secretNames: Object.keys((row.secrets ?? {}) as Record<string, string>),
    }));
  }

  /**
   * Update an environment: rename, replace `values`, and apply a secret delta (set
   * named secrets, clear `removeSecrets`). Returns the redacted view (names only);
   * secret values are never echoed. Throws if the environment doesn't exist.
   */
  async update(id: string, input: UpdateEnvironmentInput): Promise<EnvironmentView> {
    const [row] = await this.db
      .select({ secrets: environments.secrets })
      .from(environments)
      .where(eq(environments.id, id))
      .limit(1);
    if (!row) throw new NotFoundException(`Environment ${id} not found`);

    const patch: Partial<typeof environments.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.values !== undefined) patch.values = input.values; // full-map replace

    // Secret delta: only rewrite the secrets jsonb when the caller sent one.
    if (input.secrets !== undefined || input.removeSecrets !== undefined) {
      const nextSecrets = { ...((row.secrets ?? {}) as Record<string, string>) };
      for (const [k, v] of Object.entries(input.secrets ?? {})) nextSecrets[k] = v;
      for (const k of input.removeSecrets ?? []) delete nextSecrets[k];
      patch.secrets = nextSecrets;
    }

    if (Object.keys(patch).length > 0) {
      await this.db.update(environments).set(patch).where(eq(environments.id, id));
    }
    return this.getById(id);
  }

  /**
   * Delete an environment. Allowed even when runs reference it — `runs.environmentId`
   * has no FK, and the run views degrade a dangling id to the `"default"` display name
   * (PRD §B). Throws if the environment doesn't exist.
   */
  async delete(id: string): Promise<{ ok: true }> {
    const deleted = await this.db
      .delete(environments)
      .where(eq(environments.id, id))
      .returning({ id: environments.id });
    if (deleted.length === 0) throw new NotFoundException(`Environment ${id} not found`);
    return { ok: true };
  }
}
