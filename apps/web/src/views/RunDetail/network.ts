import type { RunNetworkEvent, RunView } from "@varys/review-contract";

/**
 * Reading the API traffic a run recorded.
 *
 * Why the viewer surfaces this at all: a run whose real cause is the backend reads as a locator
 * failure, because `failureKind` comes from the thrown exception's type and the matcher cannot
 * tell a renamed button from one that never rendered. These helpers put the requests beside the
 * step that made them, so the reader sees the cause instead of inferring it from the label.
 */

/** Whether this request is something to explain a failure with. Mirrors `isProblem` in
 *  @varys/runner — a 3xx is normal (each redirect hop is its own request), a 4xx/5xx, a
 *  transport error, and an unanswered request are not. */
export function isProblemRequest(event: RunNetworkEvent): boolean {
  return event.failureText !== null || (event.status !== null && event.status >= 400);
}

/**
 * The failed / errored / unanswered requests worth warning about on a FAILED run — the run-level
 * alert's whole condition, exported so the view can decide whether to render a container at all
 * without duplicating the rule.
 *
 * Empty for a run that passed: a failed request on a green run is not a finding, it is an app
 * that tolerated one, and warning about it would train people to ignore the warning.
 */
export function runNetworkProblems(run: RunView): RunNetworkEvent[] {
  if (run.status !== "failed") return [];
  return run.network.filter(isProblemRequest);
}

/** The run's requests grouped by the step that was executing when each STARTED. The `null` key
 *  holds requests that began outside any step (context setup, or after the last step). */
export function groupNetworkByStep(
  events: readonly RunNetworkEvent[],
): Map<number | null, RunNetworkEvent[]> {
  const byStep = new Map<number | null, RunNetworkEvent[]>();
  for (const event of events) {
    const list = byStep.get(event.stepIndex) ?? [];
    list.push(event);
    byStep.set(event.stepIndex, list);
  }
  return byStep;
}

/** How many problem requests each step saw — what the rail badges. */
export function problemCountByStep(run: RunView): Map<number | null, number> {
  const counts = new Map<number | null, number>();
  for (const event of run.network) {
    if (!isProblemRequest(event)) continue;
    counts.set(event.stepIndex, (counts.get(event.stepIndex) ?? 0) + 1);
  }
  return counts;
}

/** The short status token for a request: its code, its transport error, or "no response" for
 *  one the server never answered — which is what an API timeout looks like from the browser. */
export function statusToken(event: RunNetworkEvent): string {
  if (event.status !== null) return String(event.status);
  if (event.failureText === null) return "—";
  // `net::ERR_TIMED_OUT` → `ERR_TIMED_OUT`; anything else is already short enough to read.
  const net = event.failureText.match(/net::(ERR_[A-Z_]+)/);
  if (net) return net[1];
  return event.failureText.startsWith("no response") ? "no response" : event.failureText;
}

/** Path + query only — the host is the same for every request in a run and eats the column. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}
