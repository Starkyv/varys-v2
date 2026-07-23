import "./load-env"; // FIRST — populate process.env from .env before anything reads it
import { createDb } from "@varys/db";
import { createBoss, startBoss, workRuns } from "@varys/queue";
import { processRun } from "@varys/runner";
import { createStorageFromEnv } from "@varys/storage-adapter";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const { db } = createDb(connectionString);
  // local FS (default) or Azure Blob, selected by VARYS_STORAGE_DRIVER — must match the API.
  const storage = createStorageFromEnv();
  const boss = createBoss(connectionString);

  await startBoss(boss);
  // The judge for context checkpoints is built inside processRun per run (from the Configurations
  // page settings, env fallback), so a settings change applies without restarting the worker.
  await workRuns(boss, (runId) => processRun({ db, storage }, runId));

  // eslint-disable-next-line no-console
  console.log("varys worker started, waiting for run jobs…");
}

void main();
