import type {
  EnvironmentView,
  NeedsReviewItem,
  PersistResult,
  ReEvaluation,
  RunSummary,
  RunView,
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
