import { createDb } from "@varys/db";
import { createBoss, startBoss, workRuns } from "@varys/queue";
import { processRun } from "@varys/runner";
import { LocalFsAdapter } from "@varys/storage-adapter";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const { db } = createDb(connectionString);
  const storage = new LocalFsAdapter(process.env.VARYS_STORAGE_DIR ?? "./.varys-artifacts");
  const boss = createBoss(connectionString);

  await startBoss(boss);
  await workRuns(boss, (runId) => processRun({ db, storage }, runId));

  // eslint-disable-next-line no-console
  console.log("varys worker started, waiting for run jobs…");
}

void main();
