// Re-export the shared schema so existing intra-app imports keep working.
export {
  baselines,
  DDL,
  draftPreviews,
  environments,
  folders,
  runResults,
  runs,
  runSteps,
  schema,
  suiteRuns,
  suites,
  suiteTests,
  tests,
  testSchedules,
  testTags,
  testVersions,
} from "@varys/db";
export type { Db, DbHandle, RunStatus } from "@varys/db";
