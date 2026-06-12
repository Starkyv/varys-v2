import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { DDL } from "../src/db/schema";

export interface TestDb {
  container: StartedPostgreSqlContainer;
  connectionString: string;
}

/** Start a throwaway Postgres in Docker and apply the schema. */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const connectionString = container.getConnectionUri();

  const pool = new Pool({ connectionString });
  await pool.query(DDL);
  await pool.end();

  return { container, connectionString };
}
