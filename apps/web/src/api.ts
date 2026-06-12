import type { NeedsReviewItem, RunView } from "@varys/review-contract";

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
