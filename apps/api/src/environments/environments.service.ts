import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { environments } from "@varys/db";
import type { EnvCookie, EnvLocalStorageItem } from "@varys/review-contract";
import { asc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

export interface CreateEnvironmentInput {
  name: string;
  baseUrl?: string;
  cookies?: EnvCookie[];
  localStorage?: EnvLocalStorageItem[];
}

/**
 * Update body. Any present field REPLACES the current value (full replace is fine for MVP).
 * Omitted fields are left untouched. An environment is just a run target now: base URL +
 * cookies + localStorage.
 */
export interface UpdateEnvironmentInput {
  name?: string;
  baseUrl?: string;
  cookies?: EnvCookie[];
  localStorage?: EnvLocalStorageItem[];
}

export interface EnvironmentView {
  id: string;
  name: string;
  baseUrl: string;
  cookies: EnvCookie[];
  localStorage: EnvLocalStorageItem[];
}

@Injectable()
export class EnvironmentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(input: CreateEnvironmentInput): Promise<{ id: string }> {
    const [env] = await this.db
      .insert(environments)
      .values({
        name: input.name,
        baseUrl: input.baseUrl ?? "",
        cookies: input.cookies ?? [],
        localStorage: input.localStorage ?? [],
      })
      .returning({ id: environments.id });
    return { id: env.id };
  }

  async getById(id: string): Promise<EnvironmentView> {
    const [row] = await this.db
      .select({
        name: environments.name,
        baseUrl: environments.baseUrl,
        cookies: environments.cookies,
        localStorage: environments.localStorage,
      })
      .from(environments)
      .where(eq(environments.id, id))
      .limit(1);
    if (!row) throw new NotFoundException(`Environment ${id} not found`);

    return {
      id,
      name: row.name,
      baseUrl: row.baseUrl ?? "",
      cookies: (row.cookies ?? []) as EnvCookie[],
      localStorage: (row.localStorage ?? []) as EnvLocalStorageItem[],
    };
  }

  /** List every environment (creation order). */
  async list(): Promise<EnvironmentView[]> {
    const rows = await this.db
      .select({
        id: environments.id,
        name: environments.name,
        baseUrl: environments.baseUrl,
        cookies: environments.cookies,
        localStorage: environments.localStorage,
      })
      .from(environments)
      .orderBy(asc(environments.createdAt));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl ?? "",
      cookies: (row.cookies ?? []) as EnvCookie[],
      localStorage: (row.localStorage ?? []) as EnvLocalStorageItem[],
    }));
  }

  /**
   * Update an environment: rename, and replace baseUrl / cookies / localStorage. Any present
   * field is written; omitted ones are left untouched. Throws if the environment doesn't exist.
   */
  async update(id: string, input: UpdateEnvironmentInput): Promise<EnvironmentView> {
    const [row] = await this.db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.id, id))
      .limit(1);
    if (!row) throw new NotFoundException(`Environment ${id} not found`);

    const patch: Partial<typeof environments.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;
    if (input.cookies !== undefined) patch.cookies = input.cookies; // full-list replace
    if (input.localStorage !== undefined) patch.localStorage = input.localStorage; // full-list replace

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
