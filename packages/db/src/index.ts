import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "./schema";

export * from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: Pool;
}

/** Create a drizzle DB + its pg Pool. Caller owns closing the pool. */
export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}
