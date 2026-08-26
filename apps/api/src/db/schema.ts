// Re-export the shared schema so existing intra-app imports keep working.
export {
  agentCredentials,
  appSettings,
  baselines,
  DDL,
  draftPreviews,
  environments,
  folders,
  repairJobs,
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
export type { Db, DbHandle, RepairJobKind, RepairJobStatus, RunStatus } from "@varys/db";
