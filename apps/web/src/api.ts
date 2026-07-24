import type {
  AuthoringInstructionsView,
  AuthoringSessionSummary,
  BridgeChatState,
  DashboardView,
  McpStatus,
  DraftSummary,
  DraftView,
  EnvCookie,
  EnvLocalStorageItem,
  EnvironmentView,
  FolderSummary,
  ImageComparisonSettings,
  JudgeSettingsPatch,
  JudgeSettingsView,
  LocatorVerifyRequest,
  LocatorVerifyResult,
  NeedsReviewItem,
  PromoteDraftBody,
  PersistResult,
  ReEvaluation,
  RunSummary,
  RunView,
  SaveConfigResult,
  SuiteRunSummary,
  SuiteRunView,
  SuiteSummary,
  SuiteView,
  TestConfigPatch,
  TestConfigView,
  TestScheduleInput,
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

/** Fetch the dashboard read-model (KPI summary + recent-runs feed). Throws on a
 *  non-2xx response. */
export async function fetchDashboard(): Promise<DashboardView> {
  const res = await fetch(`${API_BASE}/dashboard`);
  if (!res.ok) {
    throw new Error(`Failed to load the dashboard (${res.status})`);
  }
  return (await res.json()) as DashboardView;
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
export async function fetchRuns(testId?: string): Promise<RunSummary[]> {
  const qs = testId ? `?testId=${encodeURIComponent(testId)}` : "";
  const res = await fetch(`${API_BASE}/runs${qs}`);
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

/** Fetch the AI-authored Draft review queue (newest first). Throws on a non-2xx. */
export async function fetchDrafts(): Promise<DraftSummary[]> {
  const res = await fetch(`${API_BASE}/drafts`);
  if (!res.ok) {
    throw new Error(`Failed to load the review queue (${res.status})`);
  }
  return (await res.json()) as DraftSummary[];
}

/** Fetch the active Authoring Sessions to watch live (Slice 15 — Author with AI). Throws on a
 *  non-2xx response. The per-session frame stream is consumed separately via EventSource. */
export async function fetchAuthoringSessions(): Promise<AuthoringSessionSummary[]> {
  const res = await fetch(`${API_BASE}/authoring/sessions`);
  if (!res.ok) {
    throw new Error(`Failed to load authoring sessions (${res.status})`);
  }
  return (await res.json()) as AuthoringSessionSummary[];
}

/** Start an in-product authoring chat (a Bridge) and get its one-time pairing code (Slice 15).
 *  The conversation streams over EventSource; prompts go up via sendBridgePrompt. */
export async function createBridge(): Promise<BridgeChatState> {
  const res = await fetch(`${API_BASE}/authoring/bridge`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Failed to start an authoring session (${res.status})`);
  }
  return (await res.json()) as BridgeChatState;
}

/** Send a prompt down to the paired Bridge Helper for this chat (Slice 15). */
export async function sendBridgePrompt(chatId: string, text: string): Promise<void> {
  const res = await fetch(`${API_BASE}/authoring/bridge/${chatId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Failed to send prompt (${res.status})`);
  }
}

/** Read the editable AI authoring instructions (the MCP `initialize` prompt) for the Author-page
 *  editor. Throws on a non-2xx response. */
export async function fetchAuthoringInstructions(): Promise<AuthoringInstructionsView> {
  const res = await fetch(`${API_BASE}/authoring/instructions`);
  if (!res.ok) {
    throw new Error(`Failed to load authoring instructions (${res.status})`);
  }
  return (await res.json()) as AuthoringInstructionsView;
}

/** Save the authoring instructions. Pass `base` and/or `additional` — an omitted layer is left
 *  untouched. A `base` equal to the default (or empty) clears its override; empty `additional`
 *  clears that layer. */
export async function saveAuthoringInstructions(body: {
  base?: string;
  additional?: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/authoring/instructions`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to save authoring instructions (${res.status})`);
  }
}

/** Global image-comparison defaults (Configurations page) — the two thresholds applied to every
 *  checkpoint diff. */
export async function fetchImageComparisonSettings(): Promise<ImageComparisonSettings> {
  const res = await fetch(`${API_BASE}/settings/image-comparison`);
  if (!res.ok) {
    throw new Error(`Failed to load image-comparison settings (${res.status})`);
  }
  return (await res.json()) as ImageComparisonSettings;
}

/** Save the image-comparison defaults. Pass `perPixel` and/or `ratio` — an omitted field is left
 *  untouched. Returns the new effective settings (after server-side clamping to 0–1). */
export async function saveImageComparisonSettings(
  body: Partial<ImageComparisonSettings>,
): Promise<ImageComparisonSettings> {
  const res = await fetch(`${API_BASE}/settings/image-comparison`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to save image-comparison settings (${res.status})`);
  }
  return (await res.json()) as ImageComparisonSettings;
}

/** The judge (context-compare) config — masked (no API key returned, only a set-flag + hint). */
export async function fetchJudgeSettings(): Promise<JudgeSettingsView> {
  const res = await fetch(`${API_BASE}/settings/judge`);
  if (!res.ok) throw new Error(`Failed to load judge settings (${res.status})`);
  return (await res.json()) as JudgeSettingsView;
}

/** Save the judge config. A non-empty `apiKey` replaces the stored key; omit it to keep the current
 *  one. Returns the new masked view. */
export async function saveJudgeSettings(body: JudgeSettingsPatch): Promise<JudgeSettingsView> {
  const res = await fetch(`${API_BASE}/settings/judge`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to save judge settings (${res.status})`);
  return (await res.json()) as JudgeSettingsView;
}

/** Whether Claude Code has recently driven the MCP server — an activity-based "connected" proxy
 *  (the MCP transport is stateless HTTP). Slice 15. */
export async function fetchMcpStatus(): Promise<McpStatus> {
  const res = await fetch(`${API_BASE}/authoring/mcp-status`);
  if (!res.ok) {
    throw new Error(`Failed to load MCP status (${res.status})`);
  }
  return (await res.json()) as McpStatus;
}

/** Fetch one draft's detail (per-checkpoint authoring previews) for the promote view. */
export async function fetchDraft(id: string): Promise<DraftView> {
  const res = await fetch(`${API_BASE}/drafts/${id}`);
  if (!res.ok) {
    throw new Error(`Failed to load draft ${id} (${res.status})`);
  }
  return (await res.json()) as DraftView;
}

/** Promote a draft into the active corpus (folder + tags + active). 409 if it's not a
 *  draft (already promoted). Throws on a non-2xx response. */
export async function promoteDraft(id: string, body: PromoteDraftBody): Promise<void> {
  const res = await fetch(`${API_BASE}/drafts/${id}/promote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 409
        ? "This draft was already promoted — reload the review queue."
        : `Failed to promote draft (${res.status})`,
    );
  }
}

/** Discard a draft — hard-delete (irreversible). Throws on a non-2xx response. */
export async function discardDraft(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/drafts/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Failed to discard draft (${res.status})`);
  }
}

/** Relational metadata for a test — name, folder (null unfiles), tags (full-list
 *  replace), and/or the cron schedule (`null` clears it, Slice 8). Never the
 *  definition: the server writes only relational rows (no new test version). */
export interface UpdateTestBody {
  name?: string;
  folderId?: string | null;
  tags?: string[];
  schedule?: TestScheduleInput | null;
  /** Free-form note; `null`/empty clears it. Omit to leave unchanged. */
  notes?: string | null;
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

/** Hard-delete a test — removes it and ALL its runs, baselines, and history. No
 *  rollback. Throws on a non-2xx response. */
export async function deleteTest(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/tests/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Failed to delete test (${res.status})`);
  }
}

/** Set (or clear) a run's free-form note. Empty string clears it. Throws on a non-2xx. */
export async function updateRunNotes(id: string, notes: string | null): Promise<void> {
  const res = await fetch(`${API_BASE}/runs/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  if (!res.ok) {
    throw new Error(`Failed to save note (${res.status})`);
  }
}

/** Delete a single run and its results/steps (irreversible). Baselines are untouched.
 *  Throws on a non-2xx response. */
export async function deleteRun(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/runs/${id}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Failed to delete run (${res.status})`);
  }
}

/** Fetch a test's editable config (waits + threshold of its latest version). */
export async function fetchTestConfig(id: string): Promise<TestConfigView> {
  const res = await fetch(`${API_BASE}/tests/${id}/config`);
  if (!res.ok) {
    throw new Error(`Failed to load test config (${res.status})`);
  }
  return (await res.json()) as TestConfigView;
}

/** Save a config patch — writes a new test version. A 409 means the test changed
 *  since it was opened (stale baseVersion); surface that distinctly so the caller can
 *  prompt a reload. Throws on any non-2xx. */
export async function saveTestConfig(
  id: string,
  patch: TestConfigPatch,
): Promise<SaveConfigResult> {
  const res = await fetch(`${API_BASE}/tests/${id}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 409
        ? "This test changed since you opened it. Reload to get the latest, then re-apply your edits."
        : `Failed to save test config (${res.status})`,
    );
  }
  return (await res.json()) as SaveConfigResult;
}

/** Live-verify a candidate (unsaved) locator at one step against a chosen environment — a
 *  transient partial replay; persists nothing. 409 = superseded by a newer verify. */
export async function verifyLocator(
  id: string,
  body: LocatorVerifyRequest,
): Promise<LocatorVerifyResult> {
  const res = await fetch(`${API_BASE}/tests/${id}/config/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 409
        ? "Superseded by a newer verify."
        : `Couldn’t verify the locator (${res.status})`,
    );
  }
  return (await res.json()) as LocatorVerifyResult;
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

/** Create a folder, optionally nested under `parentId`. 409 (name taken) surfaces as an error. */
export async function createFolder(name: string, parentId?: string | null): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, parentId: parentId ?? null }),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 409 ? `A folder named “${name}” already exists here` : `Failed to create folder (${res.status})`,
    );
  }
  return (await res.json()) as { id: string };
}

/** Move a folder under a new parent (null = root). 400 on a cycle, 409 on a name clash. */
export async function moveFolder(id: string, parentId: string | null): Promise<void> {
  const res = await fetch(`${API_BASE}/folders/${id}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentId }),
  });
  if (!res.ok) {
    let message = `Failed to move folder (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      /* non-JSON error body — keep the default */
    }
    throw new Error(message);
  }
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
  folderIds?: string[];
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

/** Update a suite — rename and/or replace the member list wholesale, and/or set the cron schedule
 *  (`schedule: null` clears it). */
export async function updateSuite(
  id: string,
  body: {
    name?: string;
    testIds?: string[];
    folderIds?: string[];
    schedule?: TestScheduleInput | null;
  },
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
  trace?: boolean,
): Promise<{ suiteRunId: string }> {
  const res = await fetch(`${API_BASE}/suites/${suiteId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environmentIds, trace: trace ?? false }),
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
  baseUrl?: string;
  cookies?: EnvCookie[];
  localStorage?: EnvLocalStorageItem[];
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

/** Update body: any present field replaces the current value; omitted fields are left
 *  untouched. An environment is just a run target (base URL + cookies + localStorage). */
export interface UpdateEnvironmentBody {
  name?: string;
  baseUrl?: string;
  /** Full-list replace of the env's pre-run cookies. */
  cookies?: EnvCookie[];
  /** Full-list replace of the env's pre-run localStorage entries. */
  localStorage?: EnvLocalStorageItem[];
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
  trace?: boolean,
): Promise<{ runId: string }> {
  const body: { testId: string; environmentId?: string; trace?: boolean } = { testId };
  if (environmentId) body.environmentId = environmentId;
  if (trace) body.trace = true;
  const res = await fetch(`${API_BASE}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
