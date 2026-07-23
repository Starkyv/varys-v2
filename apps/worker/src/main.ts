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

  // How many runs execute concurrently. Default 3; override with VARYS_RUN_CONCURRENCY (each run
  // drives its own headless Chromium, so raise this only as far as the host's CPU/RAM allows).
  const parsed = Number(process.env.VARYS_RUN_CONCURRENCY);
  const concurrency = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 3;

  await startBoss(boss);
  // The judge for context checkpoints is built inside processRun per run (from the Configurations
  // page settings, env fallback), so a settings change applies without restarting the worker.
  await workRuns(boss, (runId) => processRun({ db, storage }, runId), concurrency);

  // eslint-disable-next-line no-console
  console.log(`varys worker started (concurrency ${concurrency}), waiting for run jobs…`);
}

void main();
