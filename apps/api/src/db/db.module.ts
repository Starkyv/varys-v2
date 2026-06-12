import { Global, Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { createDb, type Db, type DbHandle } from "@varys/db";
import type { Pool } from "pg";

export const DB = Symbol("DB");
export const PG_POOL = Symbol("PG_POOL");
const DB_HANDLE = Symbol("DB_HANDLE");

export type { Db };

@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE,
      useFactory: (): DbHandle => {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) throw new Error("DATABASE_URL is not set");
        return createDb(connectionString);
      },
    },
    { provide: DB, inject: [DB_HANDLE], useFactory: (h: DbHandle) => h.db },
    { provide: PG_POOL, inject: [DB_HANDLE], useFactory: (h: DbHandle) => h.pool },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
