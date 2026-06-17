// Re-export the shared schema so existing intra-app imports keep working.
export {
  baselines,
  DDL,
  draftPreviews,
  folders,
  runResults,
  runs,
  runSteps,
  schema,
  suiteRuns,
  suites,
  suiteTests,
  tests,
  testTags,
  testVersions,
} from "@varys/db";
export type { Db, DbHandle, RunStatus } from "@varys/db";
