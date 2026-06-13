import type {
  EnvironmentView,
  FolderSummary,
  NeedsReviewItem,
  PersistResult,
  ReEvaluation,
  RunSummary,
  RunView,
  SuiteRunSummary,
  SuiteRunView,
  SuiteSummary,
  SuiteView,
  TestSummary,
  TuningInput,
} from "@varys/review-contract";

/**
 * Base URL of the NestJS API. Same-origin ("") by default: the SPA and API are
 * served from one origin (a Vite dev proxy locally, an ingress in prod), and the
 * artifact route is already a same-origin relative path (`/artifacts/:token`), so
 * the read-model and images need no CORS or separate credentials. Overridable at
 * build time via VITE_API_BASE for a split-origin deploy.
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

/** Fetch the per-run review read-model. Throws on a non-2xx response. */
export async function fetchRunView(runId: string): Promise<RunView> {
  const res = await fetch(`${API_BASE}/runs/${runId}`);
  if (!res.ok) {
    throw new Error(`Failed to load run ${runId} (${res.status})`);
  }
  return (await res.json()) as RunView;
}

/** Fetch the flat "needs review" list. Throws on a non-2xx response. */
export async function fetchNeedsReview(): Promise<NeedsReviewItem[]> {
  const res = await fetch(`${API_BASE}/runs/needs-review`);
  if (!res.ok) {
    throw new Error(`Failed to load the review queue (${res.status})`);
  }
  return (await res.json()) as NeedsReviewItem[];
}

/** Fetch the Runs history (every run, newest first). Throws on a non-2xx response. */
export async function fetchRuns(): Promise<RunSummary[]> {
  const res = await fetch(`${API_BASE}/runs`);
  if (!res.ok) {
    throw new Error(`Failed to load runs (${res.status})`);
  }
  return (await res.json()) as RunSummary[];
}

/** Fetch the saved tests (recordings). Throws on a non-2xx response. */
export async function fetchTests(): Promise<TestSummary[]> {
  const res = await fetch(`${API_BASE}/tests`);
  if (!res.ok) {
    throw new Error(`Failed to load tests (${res.status})`);
  }
  return (await res.json()) as TestSummary[];
}

/** Organization metadata for a test — name, folder (null unfiles), and/or tags
 *  (full-list replace). Never the definition: the server writes only organization
 *  rows (no new test version). */
export interface UpdateTestBody {
  name?: string;
  folderId?: string | null;
  tags?: string[];
}

/** Rename / (un)file a test. Throws on a non-2xx response. */
export async function updateTest(id: string, body: UpdateTestBody): Promise<void> {
  const res = await fetch(`${API_BASE}/tests/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to update test (${res.status})`);
  }
}

/** Fetch the distinct tags currently in use (for pickers/filters). */
export async function fetchTags(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/tags`);
  if (!res.ok) {
    throw new Error(`Failed to load tags (${res.status})`);
  }
  return (await res.json()) as string[];
}

/** Fetch all folders (with test counts). Throws on a non-2xx response. */
export async function fetchFolders(): Promise<FolderSummary[]> {
  const res = await fetch(`${API_BASE}/folders`);
  if (!res.ok) {
    throw new Error(`Failed to load folders (${res.status})`);
  }
  return (await res.json()) as FolderSummary[];
}

/** Create a folder. 409 (name taken) surfaces as an error. */
export async function createFolder(name: string): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 409 ? `A folder named “${name}” already exists` : `Failed to create folder (${res.status})`,
    );
  }
  return (await res.json()) as { id: string };
}

/** Rename a folder. 409 (name taken) surfaces as an error. */
export async function renameFolder(id: string, name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/folders/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 409 ? `A folder named “${name}” already exists` : `Failed to rename folder (${res.status})`,
    );
  }
}

/** Delete a folder — its tests become Unfiled (never deleted). */
export async function deleteFolder(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/folders/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Failed to delete folder (${res.status})`);
  }
}

/** Fetch all suites (with member counts). Throws on a non-2xx response. */
export async function fetchSuites(): Promise<SuiteSummary[]> {
  const res = await fetch(`${API_BASE}/suites`);
  if (!res.ok) {
    throw new Error(`Failed to load suites (${res.status})`);
  }
  return (await res.json()) as SuiteSummary[];
}

/** Fetch one suite with its member tests. Throws on a non-2xx response. */
export async function fetchSuite(id: string): Promise<SuiteView> {
  const res = await fetch(`${API_BASE}/suites/${id}`);
  if (!res.ok) {
    throw new Error(`Failed to load suite (${res.status})`);
  }
  return (await res.json()) as SuiteView;
}

/** Create a suite (optionally with initial members). Returns the new id. */
export async function createSuite(body: {
  name: string;
  testIds?: string[];
}): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/suites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to create suite (${res.status})`);
  }
  return (await res.json()) as { id: string };
}

/** Update a suite — rename and/or replace the member list wholesale. */
export async function updateSuite(
  id: string,
  body: { name?: string; testIds?: string[] },
): Promise<void> {
  const res = await fetch(`${API_BASE}/suites/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to update suite (${res.status})`);
  }
}

/** Delete a suite — memberships only; the member tests are untouched. */
export async function deleteSuite(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/suites/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Failed to delete suite (${res.status})`);
  }
}

/** Trigger a suite run — fans out one run per (member test × environment);
 *  an empty selection runs each test env-less ("default"). */
export async function triggerSuiteRun(
  suiteId: string,
  environmentIds: string[],
): Promise<{ suiteRunId: string }> {
  const res = await fetch(`${API_BASE}/suites/${suiteId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environmentIds }),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 400
        ? "This suite has no member tests yet — add some before running it"
        : `Failed to start suite run (${res.status})`,
    );
  }
  return (await res.json()) as { suiteRunId: string };
}

/** Fetch the suite-run history (aggregates, newest first). */
export async function fetchSuiteRuns(): Promise<SuiteRunSummary[]> {
  const res = await fetch(`${API_BASE}/suite-runs`);
  if (!res.ok) {
    throw new Error(`Failed to load suite runs (${res.status})`);
  }
  return (await res.json()) as SuiteRunSummary[];
}

/** Fetch one suite-run report (aggregate + per-child rows). */
export async function fetchSuiteRun(id: string): Promise<SuiteRunView> {
  const res = await fetch(`${API_BASE}/suite-runs/${id}`);
  if (!res.ok) {
    throw new Error(`Failed to load suite run (${res.status})`);
  }
  return (await res.json()) as SuiteRunView;
}

/** Fetch all environments (secrets are names-only). Throws on a non-2xx response. */
export async function fetchEnvironments(): Promise<EnvironmentView[]> {
  const res = await fetch(`${API_BASE}/environments`);
  if (!res.ok) {
    throw new Error(`Failed to load environments (${res.status})`);
  }
  return (await res.json()) as EnvironmentView[];
}

export interface CreateEnvironmentBody {
  name: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
}

/** Create an environment. Returns the new id. Throws on a non-2xx response. */
export async function createEnvironment(body: CreateEnvironmentBody): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/environments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to create environment (${res.status})`);
  }
  return (await res.json()) as { id: string };
}

/** Update body: `values` REPLACES the whole map; secrets are a write-only delta
 *  (`secrets` sets, `removeSecrets` clears). Omitted fields are left untouched. */
export interface UpdateEnvironmentBody {
  name?: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
  removeSecrets?: string[];
}

/** Update an environment. Returns the redacted view (secret names only). Throws on
 *  a non-2xx response. */
export async function updateEnvironment(
  id: string,
  body: UpdateEnvironmentBody,
): Promise<EnvironmentView> {
  const res = await fetch(`${API_BASE}/environments/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to update environment (${res.status})`);
  }
  return (await res.json()) as EnvironmentView;
}

/** Delete an environment. Throws on a non-2xx response. */
export async function deleteEnvironment(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/environments/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Failed to delete environment (${res.status})`);
  }
}

/** Trigger a run of a saved test, optionally against an environment. Returns the new
 *  run id. The worker resolves the recording's `{{tokens}}` against that environment. */
export async function runTest(
  testId: string,
  environmentId?: string,
): Promise<{ runId: string }> {
  const res = await fetch(`${API_BASE}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(environmentId ? { testId, environmentId } : { testId }),
  });
  if (!res.ok) {
    throw new Error(`Failed to start run (${res.status})`);
  }
  return (await res.json()) as { runId: string };
}

/** Approve every checkpoint in a run that still needs review, in one audited
 *  action. Returns how many were approved. Throws on a non-2xx response. */
export async function approveAllInRun(runId: string): Promise<{ approved: number }> {
  const res = await fetch(`${API_BASE}/runs/${runId}/approve-all`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to approve all in run (${res.status})`);
  }
  return (await res.json()) as { approved: number };
}

/** Preview a checkpoint's diff with candidate masks/threshold — re-diffs the
 *  stored artifacts server-side (no re-run) and returns the new verdict + a
 *  transient diff image. Mutates nothing. */
export async function reEvaluateCheckpoint(
  runId: string,
  checkpointName: string,
  input: TuningInput,
): Promise<ReEvaluation> {
  const res = await fetch(
    `${API_BASE}/runs/${runId}/checkpoints/${encodeURIComponent(checkpointName)}/re-evaluate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to re-evaluate “${checkpointName}” (${res.status})`);
  }
  return (await res.json()) as ReEvaluation;
}

/** Commit masks/threshold: writes a new test version and re-judges this
 *  checkpoint. Throws on failure so the caller can surface it. */
export async function persistCheckpointMasks(
  runId: string,
  checkpointName: string,
  input: TuningInput,
): Promise<PersistResult> {
  const res = await fetch(
    `${API_BASE}/runs/${runId}/checkpoints/${encodeURIComponent(checkpointName)}/persist`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to save masks for “${checkpointName}” (${res.status})`);
  }
  return (await res.json()) as PersistResult;
}

export type DecisionAction = "approve" | "reject";

/** Record a reviewer's decision via the existing audited API. Throws on failure
 *  so the caller can surface an error and leave the checkpoint reviewable. */
export async function postDecision(
  runId: string,
  checkpointName: string,
  action: DecisionAction,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/runs/${runId}/checkpoints/${encodeURIComponent(checkpointName)}/${action}`,
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(`Failed to ${action} “${checkpointName}” (${res.status})`);
  }
}
