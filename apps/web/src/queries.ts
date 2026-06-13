import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TuningInput } from "@varys/review-contract";
import {
  approveAllInRun,
  type CreateEnvironmentBody,
  createEnvironment,
  createFolder,
  createSuite,
  type DecisionAction,
  deleteEnvironment,
  deleteFolder,
  deleteSuite,
  fetchEnvironments,
  fetchFolders,
  fetchNeedsReview,
  fetchRuns,
  fetchRunView,
  fetchSuite,
  fetchSuites,
  fetchTags,
  fetchTests,
  persistCheckpointMasks,
  postDecision,
  reEvaluateCheckpoint,
  renameFolder,
  runTest,
  updateSuite,
  type UpdateEnvironmentBody,
  type UpdateTestBody,
  updateEnvironment,
  updateTest,
} from "./api";

/** TanStack Query owns the run read-model; the key is reused for invalidation
 *  after an approve/reject decision. */
export function runQueryKey(runId: string) {
  return ["run", runId] as const;
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
  return useQuery({ queryKey: runsQueryKey(), queryFn: fetchRuns, refetchInterval: 3000 });
}

export function useRunView(runId: string) {
  return useQuery({
    queryKey: runQueryKey(runId),
    queryFn: () => fetchRunView(runId),
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

export function useTests() {
  return useQuery({ queryKey: testsQueryKey(), queryFn: fetchTests });
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
    mutationFn: (body: { name: string; testIds?: string[] }) => createSuite(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: suitesQueryKey() }),
  });
}

/** Rename / replace members of a suite, then refresh the list + that suite. */
export function useUpdateSuite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: { name?: string; testIds?: string[] } }) =>
      updateSuite(vars.id, vars.body),
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

/** Rename / (un)file / retag a test, then refresh tests, folder counts, and the
 *  tags-in-use list (a new tag should appear in pickers immediately). */
export function useUpdateTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: UpdateTestBody }) => updateTest(vars.id, vars.body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: testsQueryKey() });
      qc.invalidateQueries({ queryKey: foldersQueryKey() });
      qc.invalidateQueries({ queryKey: tagsQueryKey() });
    },
  });
}

/** Create a folder, then refresh the folder list. */
export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createFolder(name),
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
export function useEnvironments() {
  return useQuery({ queryKey: environmentsQueryKey(), queryFn: fetchEnvironments });
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
    mutationFn: (vars: { testId: string; environmentId?: string }) =>
      runTest(vars.testId, vars.environmentId),
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
