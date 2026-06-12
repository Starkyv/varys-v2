import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TuningInput } from "@varys/review-contract";
import {
  approveAllInRun,
  type DecisionAction,
  fetchNeedsReview,
  fetchRunView,
  fetchTests,
  persistCheckpointMasks,
  postDecision,
  reEvaluateCheckpoint,
  runTest,
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

/** Trigger a run of a saved test, then refresh the needs-review queue. */
export function useRunTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (testId: string) => runTest(testId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: needsReviewQueryKey() });
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
