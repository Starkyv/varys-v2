// Re-export the shared schema so existing intra-app imports keep working.
export {
  DDL,
  folders,
  runs,
  schema,
  suites,
  suiteTests,
  tests,
  testTags,
  testVersions,
} from "@varys/db";
export type { Db, DbHandle, RunStatus } from "@varys/db";
