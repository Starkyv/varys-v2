import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { environments } from "@varys/db";
import { eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

export interface CreateEnvironmentInput {
  name: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
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
}
