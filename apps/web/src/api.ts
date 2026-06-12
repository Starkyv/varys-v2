import type { RunView } from "@varys/review-contract";

/** Base URL of the NestJS API. Overridable at build time for non-local deploys. */
export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

/** Fetch the per-run review read-model. Throws on a non-2xx response. */
export async function fetchRunView(runId: string): Promise<RunView> {
  const res = await fetch(`${API_BASE}/runs/${runId}`);
  if (!res.ok) {
    throw new Error(`Failed to load run ${runId} (${res.status})`);
  }
  return (await res.json()) as RunView;
}
