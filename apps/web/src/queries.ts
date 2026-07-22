import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ImageComparisonSettings,
  LocatorVerifyRequest,
  PromoteDraftBody,
  TestConfigPatch,
  TuningInput,
} from "@varys/review-contract";
import {
  approveAllInRun,
  type CreateEnvironmentBody,
  createEnvironment,
  createFolder,
  createSuite,
  type DecisionAction,
  deleteEnvironment,
  deleteFolder,
  deleteRun,
  deleteSuite,
  deleteTest,
  discardDraft,
  fetchAuthoringInstructions,
  fetchAuthoringSessions,
  fetchImageComparisonSettings,
  fetchMcpStatus,
  saveAuthoringInstructions,
  saveImageComparisonSettings,
  fetchDashboard,
  fetchDraft,
  fetchDrafts,
  fetchTestConfig,
  fetchEnvironments,
  fetchFolders,
  fetchNeedsReview,
  fetchRuns,
  fetchRunView,
  fetchSuite,
  fetchSuiteRun,
  fetchSuiteRuns,
  fetchSuites,
  fetchTags,
  fetchTests,
  moveFolder,
  persistCheckpointMasks,
  postDecision,
  promoteDraft,
  reEvaluateCheckpoint,
  renameFolder,
  runTest,
  saveTestConfig,
  triggerSuiteRun,
  updateSuite,
  type UpdateEnvironmentBody,
  type UpdateTestBody,
  updateEnvironment,
  updateRunNotes,
  updateTest,
  verifyLocator,
} from "./api";

/** TanStack Query owns the run read-model; the key is reused for invalidation
 *  after an approve/reject decision. */
export function runQueryKey(runId: string) {
  return ["run", runId] as const;
}

/** Key for the dashboard read-model. */
export function dashboardQueryKey() {
  return ["dashboard"] as const;
}

/** The dashboard read-model (KPI summary + recent-runs feed). Polled so completing
 *  runs reflect in the KPIs and feed without a manual refresh. */
export function useDashboard() {
  return useQuery({
    queryKey: dashboardQueryKey(),
    queryFn: fetchDashboard,
    refetchInterval: 5000,
  });
}

/** Key for the needs-review list (Issue 4); invalidated after a decision so a
 *  resolved checkpoint leaves the list. */
export function needsReviewQueryKey() {
  return ["needs-review"] as const;
}

/** Key for the Runs history; invalidated when a run is triggered so it appears. */
export function runsQueryKey() {
  return ["runs"] as const;
}

/** The Runs history (every run). Polled so a run's status updates as the worker
 *  progresses (queued → running → terminal) without a manual refresh. */
export function useRuns() {
  return useQuery({ queryKey: runsQueryKey(), queryFn: () => fetchRuns(), refetchInterval: 3000 });
}

/** One test's run history (TestDetail "Recent runs"). Shares the `["runs"]` key prefix so a
 *  triggered/deleted run invalidates it too; polled like the global list. */
export function useTestRuns(testId: string) {
  return useQuery({
    queryKey: [...runsQueryKey(), { testId }] as const,
    queryFn: () => fetchRuns(testId),
    refetchInterval: 3000,
  });
}

export function useRunView(runId: string) {
  return useQuery({
    queryKey: runQueryKey(runId),
    queryFn: () => fetchRunView(runId),
  });
}

/** Set/clear a run's free-form note; refreshes that run's view. */
export function useUpdateRunNotes(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notes: string | null) => updateRunNotes(runId, notes),
    onSuccess: () => qc.invalidateQueries({ queryKey: runQueryKey(runId) }),
  });
}

/** Delete a single run (irreversible). Refreshes the history, the needs-review queue
 *  (a deleted run's checkpoints leave it), and the dashboard. */
export function useDeleteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => deleteRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: runsQueryKey() });
      qc.invalidateQueries({ queryKey: needsReviewQueryKey() });
      qc.invalidateQueries({ queryKey: dashboardQueryKey() });
    },
  });
}

export function testsQueryKey() {
  return ["tests"] as const;
}

export function useNeedsReview() {
  return useQuery({
    queryKey: needsReviewQueryKey(),
    queryFn: fetchNeedsReview,
    // Poll so a run that finishes (worker is async) shows up without a manual refresh.
    refetchInterval: 3000,
  });
}

export function useTests(opts?: { enabled?: boolean }) {
  return useQuery({ queryKey: testsQueryKey(), queryFn: fetchTests, enabled: opts?.enabled ?? true });
}

export function draftsQueryKey() {
  return ["drafts"] as const;
}

/** The AI-authored Draft review queue. Polled so a draft Claude just finished appears
 *  without a manual refresh. */
export function useDrafts(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: draftsQueryKey(),
    queryFn: fetchDrafts,
    refetchInterval: 5000,
    enabled: opts?.enabled ?? true,
  });
}

/** Key for the active Authoring Sessions list (Slice 15 — Author with AI). */
export function authoringSessionsQueryKey() {
  return ["authoring-sessions"] as const;
}

/** Active Authoring Sessions to watch live. Polled so sessions opening/finishing (driven from
 *  Claude Code) appear and disappear without a manual refresh; the per-session frames stream
 *  over EventSource, not through React Query. */
export function useAuthoringSessions() {
  return useQuery({
    queryKey: authoringSessionsQueryKey(),
    queryFn: fetchAuthoringSessions,
    refetchInterval: 5000,
  });
}

/** Whether Claude Code is currently driving the MCP server (activity-based). Polled so the
 *  "active / idle" indicator updates as the connection comes and goes. */
export function useMcpStatus() {
  return useQuery({
    queryKey: ["mcp-status"] as const,
    queryFn: fetchMcpStatus,
    refetchInterval: 5000,
  });
}

export function authoringInstructionsQueryKey() {
  return ["authoring-instructions"] as const;
}

/** The editable AI authoring instructions (MCP prompt). Fetched lazily — only when the editor
 *  opens — since it's a config surface, not part of the live view. */
export function useAuthoringInstructions(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: authoringInstructionsQueryKey(),
    queryFn: fetchAuthoringInstructions,
    enabled: opts?.enabled ?? true,
  });
}

export function useSaveAuthoringInstructions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { base?: string; additional?: string }) => saveAuthoringInstructions(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: authoringInstructionsQueryKey() }),
  });
}

export function imageComparisonSettingsQueryKey() {
  return ["settings", "image-comparison"] as const;
}

/** The global image-comparison defaults (Configurations page). */
export function useImageComparisonSettings() {
  return useQuery({
    queryKey: imageComparisonSettingsQueryKey(),
    queryFn: fetchImageComparisonSettings,
  });
}

/** Save the image-comparison defaults; seeds the cache with the server's clamped response. */
export function useSaveImageComparisonSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ImageComparisonSettings>) => saveImageComparisonSettings(body),
    onSuccess: (next) => qc.setQueryData(imageComparisonSettingsQueryKey(), next),
  });
}

export function draftQueryKey(id: string) {
  return ["draft", id] as const;
}

/** One draft's detail (per-checkpoint authoring previews) — fetched when its promote
 *  dialog opens. */
export function useDraft(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: draftQueryKey(id),
    queryFn: () => fetchDraft(id),
    enabled: opts?.enabled ?? true,
  });
}

/** Promote a draft (folder + tags + active). On success it leaves the review queue and
 *  joins the active Tests list, so refresh both (plus folder counts + tags-in-use). */
export function usePromoteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: PromoteDraftBody }) => promoteDraft(vars.id, vars.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: draftsQueryKey() });
      qc.invalidateQueries({ queryKey: testsQueryKey() });
      qc.invalidateQueries({ queryKey: foldersQueryKey() });
      qc.invalidateQueries({ queryKey: tagsQueryKey() });
    },
  });
}

/** Discard a draft (hard-delete), then refresh the review queue. */
export function useDiscardDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => discardDraft(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: draftsQueryKey() }),
  });
}

/** Rename an AI-authored draft (PATCH /tests/:id — a draft is a test held out of the
 *  corpus). Refreshes the review-queue list and this draft's detail so the new name shows
 *  immediately; testsQueryKey too in case it's later promoted. */
export function useRenameDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name: string }) => updateTest(vars.id, { name: vars.name }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: draftsQueryKey() });
      qc.invalidateQueries({ queryKey: draftQueryKey(vars.id) });
      qc.invalidateQueries({ queryKey: testsQueryKey() });
    },
  });
}

export function testConfigQueryKey(id: string) {
  return ["test-config", id] as const;
}

/** A test's editable config (waits + threshold) — the test-detail page's read. */
export function useTestConfig(id: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: testConfigQueryKey(id),
    queryFn: () => fetchTestConfig(id),
    enabled: (opts?.enabled ?? true) && !!id,
  });
}

/** Save a config patch (new test version). On success, refresh this test's config (so
 *  the editor rebases on the new version) and the tests list (its needs-environment
 *  flag is derived from the latest definition). */
export function useSaveTestConfig(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: TestConfigPatch) => saveTestConfig(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: testConfigQueryKey(id) });
      qc.invalidateQueries({ queryKey: testsQueryKey() });
    },
  });
}

/** Live-verify a candidate locator (Slice 16.3b). A transient probe — nothing to cache;
 *  the caller stashes the verdict per step. */
export function useVerifyLocator(id: string) {
  return useMutation({
    mutationFn: (body: LocatorVerifyRequest) => verifyLocator(id, body),
  });
}

export function foldersQueryKey() {
  return ["folders"] as const;
}

/** The folders list — drives the Tests view's folder filter + organize affordance. */
export function useFolders() {
  return useQuery({ queryKey: foldersQueryKey(), queryFn: fetchFolders });
}

export function tagsQueryKey() {
  return ["tags"] as const;
}

/** The distinct tags in use — drives the tag filter + the organize editor's picker. */
export function useTags() {
  return useQuery({ queryKey: tagsQueryKey(), queryFn: fetchTags });
}

export function suitesQueryKey() {
  return ["suites"] as const;
}

export function suiteQueryKey(id: string) {
  return ["suite", id] as const;
}

/** The suites list (with member counts) — the Suites tab's main read. */
export function useSuites() {
  return useQuery({ queryKey: suitesQueryKey(), queryFn: fetchSuites });
}

/** One suite with its member tests — fetched when its editor is opened. */
export function useSuite(id: string) {
  return useQuery({ queryKey: suiteQueryKey(id), queryFn: () => fetchSuite(id) });
}

/** Create a suite, then refresh the list. */
export function useCreateSuite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; testIds?: string[]; folderIds?: string[] }) =>
      createSuite(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: suitesQueryKey() }),
  });
}

/** Rename / replace members of a suite, then refresh the list + that suite. */
export function useUpdateSuite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      body: { name?: string; testIds?: string[]; folderIds?: string[] };
    }) => updateSuite(vars.id, vars.body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: suitesQueryKey() });
      qc.invalidateQueries({ queryKey: suiteQueryKey(vars.id) });
    },
  });
}

/** Delete a suite (memberships only — tests untouched), then refresh the list. */
export function useDeleteSuite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSuite(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: suitesQueryKey() }),
  });
}

export function suiteRunsQueryKey() {
  return ["suite-runs"] as const;
}

export function suiteRunQueryKey(id: string) {
  return ["suite-run", id] as const;
}

/** The suite-run history (aggregates). Polled so derived statuses advance as the
 *  worker drains the fan-out. */
export function useSuiteRuns() {
  return useQuery({
    queryKey: suiteRunsQueryKey(),
    queryFn: fetchSuiteRuns,
    refetchInterval: 3000,
  });
}

/** One suite-run report. Polls while any child is still in flight, then stops —
 *  a terminal report only changes through review actions, not on its own. */
export function useSuiteRun(id: string) {
  return useQuery({
    queryKey: suiteRunQueryKey(id),
    queryFn: () => fetchSuiteRun(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 3000 : false;
    },
  });
}

/** Trigger `suite × env(s)`, then refresh the histories the fan-out lands in. */
export function useTriggerSuiteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { suiteId: string; environmentIds: string[]; trace?: boolean }) =>
      triggerSuiteRun(vars.suiteId, vars.environmentIds, vars.trace),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: suiteRunsQueryKey() });
      qc.invalidateQueries({ queryKey: needsReviewQueryKey() });
    },
  });
}

/** Rename / (un)file / retag / (re)schedule a test, then refresh tests, folder counts,
 *  the tags-in-use list (a new tag should appear in pickers immediately), and this
 *  test's config (so a saved cron schedule's nextRunAt reflects). */
export function useUpdateTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: UpdateTestBody }) => updateTest(vars.id, vars.body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: testsQueryKey() });
      qc.invalidateQueries({ queryKey: foldersQueryKey() });
      qc.invalidateQueries({ queryKey: tagsQueryKey() });
      qc.invalidateQueries({ queryKey: testConfigQueryKey(vars.id) });
    },
  });
}

/** Hard-delete a test (and all its runs/baselines/history), then refresh every
 *  surface it appears on: the tests list, folder counts, tags-in-use, and the
 *  run/review/dashboard read-models its runs fed. */
export function useDeleteTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTest(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: testsQueryKey() });
      qc.invalidateQueries({ queryKey: foldersQueryKey() });
      qc.invalidateQueries({ queryKey: tagsQueryKey() });
      qc.invalidateQueries({ queryKey: runsQueryKey() });
      qc.invalidateQueries({ queryKey: needsReviewQueryKey() });
      qc.invalidateQueries({ queryKey: dashboardQueryKey() });
    },
  });
}

/** Create a folder (optionally nested under `parentId`), then refresh the folder list. */
export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; parentId?: string | null }) => createFolder(vars.name, vars.parentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: foldersQueryKey() }),
  });
}

/** Move a folder under a new parent (null = root), then refresh the folder list. */
export function useMoveFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; parentId: string | null }) => moveFolder(vars.id, vars.parentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: foldersQueryKey() }),
  });
}

/** Rename a folder; tests carry the folder name, so refresh both. */
export function useRenameFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name: string }) => renameFolder(vars.id, vars.name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: foldersQueryKey() });
      qc.invalidateQueries({ queryKey: testsQueryKey() });
    },
  });
}

/** Delete a folder (its tests become Unfiled), then refresh both lists. */
export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFolder(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: foldersQueryKey() });
      qc.invalidateQueries({ queryKey: testsQueryKey() });
    },
  });
}

export function environmentsQueryKey() {
  return ["environments"] as const;
}

/** The environments list — drives the management screen and the Run picker. */
export function useEnvironments(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: environmentsQueryKey(),
    queryFn: fetchEnvironments,
    enabled: opts?.enabled ?? true,
  });
}

/** Create an environment, then refresh the list. */
export function useCreateEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEnvironmentBody) => createEnvironment(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: environmentsQueryKey() }),
  });
}

/** Update an environment (rename / replace values / set+clear secrets), then refresh. */
export function useUpdateEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: UpdateEnvironmentBody }) =>
      updateEnvironment(vars.id, vars.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: environmentsQueryKey() }),
  });
}

/** Delete an environment, then refresh the list. */
export function useDeleteEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteEnvironment(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: environmentsQueryKey() }),
  });
}

/** Trigger a run of a saved test (optionally against an environment), then refresh
 *  the needs-review queue. */
export function useRunTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { testId: string; environmentId?: string; trace?: boolean }) =>
      runTest(vars.testId, vars.environmentId, vars.trace),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: needsReviewQueryKey() });
      qc.invalidateQueries({ queryKey: runsQueryKey() });
    },
  });
}

/** Bulk-approve every needs-review checkpoint in a run. Invalidates the run and
 *  the needs-review list so the resolved checkpoints reflect their new state. */
export function useApproveAll(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => approveAllInRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: runQueryKey(runId) });
      qc.invalidateQueries({ queryKey: needsReviewQueryKey() });
    },
  });
}

/** Preview a checkpoint's diff with candidate masks/threshold (no mutation). The
 *  last result lives on the mutation's `data` for live display. */
export function useReEvaluate(runId: string, checkpointName: string) {
  return useMutation({
    mutationFn: (input: TuningInput) => reEvaluateCheckpoint(runId, checkpointName, input),
  });
}

/** Persist masks/threshold for a checkpoint. On success the run + needs-review
 *  list are invalidated so a now-passing checkpoint leaves the queue. */
export function usePersistMasks(runId: string, checkpointName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TuningInput) => persistCheckpointMasks(runId, checkpointName, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: runQueryKey(runId) });
      qc.invalidateQueries({ queryKey: needsReviewQueryKey() });
    },
  });
}

/** Approve/reject a checkpoint. On success the run (and the needs-review list)
 *  are invalidated so the checkpoint reflects its new state and can't be acted
 *  on twice from the same view. */
export function useDecision(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; action: DecisionAction }) =>
      postDecision(runId, vars.name, vars.action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: runQueryKey(runId) });
      qc.invalidateQueries({ queryKey: needsReviewQueryKey() });
    },
  });
}
