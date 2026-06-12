// Re-export the shared schema so existing intra-app imports keep working.
export { DDL, runs, schema, tests, testVersions } from "@varys/db";
export type { Db, DbHandle, RunStatus } from "@varys/db";
