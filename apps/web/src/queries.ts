import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DecisionAction, fetchNeedsReview, fetchRunView, postDecision } from "./api";

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

export function useNeedsReview() {
  return useQuery({
    queryKey: needsReviewQueryKey(),
    queryFn: fetchNeedsReview,
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
