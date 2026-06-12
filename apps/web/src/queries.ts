import { useQuery } from "@tanstack/react-query";
import { fetchRunView } from "./api";

/** TanStack Query owns the run read-model; the key is reused for invalidation
 *  after an approve/reject decision (later slice). */
export function runQueryKey(runId: string) {
  return ["run", runId] as const;
}

export function useRunView(runId: string) {
  return useQuery({
    queryKey: runQueryKey(runId),
    queryFn: () => fetchRunView(runId),
  });
}
