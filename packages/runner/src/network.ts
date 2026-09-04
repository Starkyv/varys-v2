import type { BrowserContext, Request } from "playwright";

/**
 * The API traffic a run saw — the evidence that tells a locator failure apart from a backend one.
 *
 * The problem this solves: `failureKind` is decided by the thrown exception's TYPE
 * (`LocatorUnresolvedError`), which is the right call for a safety decision but cannot express
 * WHY the element was missing. "The button was renamed" and "the button never rendered because
 * /api/orders returned 500" are the same exception. So a backend outage reads, on the run, as a
 * locator problem — and whoever opens it goes looking at selectors.
 *
 * This module records enough traffic to answer that, and no more. It observes only the request
 * kinds a diagnosis is ever about, keeps every PROBLEM plus the slowest few successes, and
 * attributes each request to the step that was executing when it STARTED.
 *
 * It changes nothing about how a run is classified or queued: capture and display only.
 */

/** Request kinds worth keeping. A page's images, stylesheets, fonts and scripts are not what
 *  "the API failed" is ever about, and they are the overwhelming majority of the traffic. */
export const CAPTURED_RESOURCE_TYPES = ["xhr", "fetch", "document"] as const;

/** What a run keeps. Bounds, not targets — a healthy run stores a handful of rows. */
export const NETWORK_LIMITS = {
  /** Problems kept per run, oldest first. The FIRST failure is the causal one; a run that
   *  produces more than this has told us what we need long before row 200. */
  maxProblems: 200,
  /** Slowest successful requests kept per run — the "it resolved, but it took 40 seconds"
   *  case, which is a real cause of a step timing out and leaves no failed request behind. */
  maxSlow: 20,
  /** Candidates tracked in memory before the collector stops observing. A guard on the
   *  worker's own memory for a page that fires thousands of requests, nothing more. */
  maxObserved: 2000,
} as const;

/** The marker on a request the server never answered — no response, no transport error, still
 *  outstanding when the run ended. This is what an API timeout actually looks like from the
 *  browser's side, and it is the single most diagnostic row this table can hold. */
export const UNANSWERED = "no response before the run ended";

export interface NetworkEvent {
  /** The step in flight when the request STARTED; null when it started outside any step. */
  stepIndex: number | null;
  method: string;
  url: string;
  resourceType: string;
  /** Null when no response ever arrived. */
  status: number | null;
  /** Chromium's error text, or {@link UNANSWERED}. Null when the request completed. */
  failureText: string | null;
  durationMs: number;
  ttfbMs: number | null;
  startedAt: Date;
}

/**
 * Whether this request is something to explain a failure with: a transport error, a request the
 * server never answered, or any status at or above 400.
 *
 * A 3xx is NOT a problem — Playwright reports each redirect hop as its own request, so treating
 * them as failures would fill the table with normal navigation.
 */
export function isProblem(event: NetworkEvent): boolean {
  return event.failureText !== null || (event.status !== null && event.status >= 400);
}

/**
 * The bounded set to persist: every problem in the order it happened, plus the slowest
 * successes, returned in start order so a reader follows the run's own timeline.
 *
 * Problems are taken oldest-first rather than by severity on purpose. When an app's API goes
 * down mid-run every later request fails too; the row that explains the run is the first one.
 */
export function selectNetworkEvents(
  observed: readonly NetworkEvent[],
  limits: typeof NETWORK_LIMITS = NETWORK_LIMITS,
): NetworkEvent[] {
  const problems: NetworkEvent[] = [];
  const succeeded: NetworkEvent[] = [];
  for (const event of observed) (isProblem(event) ? problems : succeeded).push(event);
  const slowest = [...succeeded]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limits.maxSlow);
  return [...problems.slice(0, limits.maxProblems), ...slowest].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
}

export interface NetworkCollector {
  /**
   * Stop observing and return the rows to persist. Requests still outstanding are flushed as
   * {@link UNANSWERED} — they never fire `requestfinished` or `requestfailed`, so without this
   * the one case the table exists for would be the one case it missed.
   *
   * Call it while the context is still open (the accessors it reads are local, but a closed
   * context is no place to find out otherwise), and only once.
   */
  finish(): NetworkEvent[];
  /** True when the observation cap was hit, so a caller can say the record is partial. */
  truncated(): boolean;
}

/** Resource timing, when Chromium supplied it. Fields are -1 when unavailable, and the whole
 *  call throws for a request that never got that far — either way we fall back to our own clock. */
function timingOf(request: Request): { durationMs: number | null; ttfbMs: number | null } {
  try {
    const timing = request.timing();
    return {
      durationMs: timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null,
      ttfbMs: timing.responseStart >= 0 ? Math.round(timing.responseStart) : null,
    };
  } catch {
    return { durationMs: null, ttfbMs: null };
  }
}

/**
 * Start recording `context`'s traffic. `currentStepIndex` is read at request START — pass the
 * runner's "which step is executing" variable so attribution needs no bookkeeping of its own.
 *
 * Every handler is synchronous. An async listener here would put unhandled rejections on the
 * worker's event loop for something that must never be able to affect a run's outcome.
 */
export function collectNetwork(
  context: BrowserContext,
  currentStepIndex: () => number | null,
): NetworkCollector {
  interface Pending {
    stepIndex: number | null;
    startMs: number;
    startedAt: Date;
    status: number | null;
  }
  const pending = new Map<Request, Pending>();
  const observed: NetworkEvent[] = [];
  let truncated = false;
  let finished = false;

  const isCandidate = (request: Request): boolean =>
    (CAPTURED_RESOURCE_TYPES as readonly string[]).includes(request.resourceType());

  context.on("request", (request) => {
    if (finished || !isCandidate(request)) return;
    if (observed.length + pending.size >= NETWORK_LIMITS.maxObserved) {
      truncated = true;
      return;
    }
    pending.set(request, {
      stepIndex: currentStepIndex(),
      startMs: Date.now(),
      startedAt: new Date(),
      status: null,
    });
  });

  // Status is taken from the `response` event rather than awaited off the request, so that
  // reading it stays synchronous. A request that fails in transport never gets one, which is
  // exactly the null we want to store.
  context.on("response", (response) => {
    const entry = pending.get(response.request());
    if (entry) entry.status = response.status();
  });

  const finalize = (request: Request, failureText: string | null): void => {
    const entry = pending.get(request);
    if (!entry || finished) return;
    pending.delete(request);
    const timing = timingOf(request);
    observed.push({
      stepIndex: entry.stepIndex,
      method: request.method(),
      url: request.url().slice(0, 2000),
      resourceType: request.resourceType(),
      status: entry.status,
      failureText,
      durationMs: timing.durationMs ?? Date.now() - entry.startMs,
      ttfbMs: timing.ttfbMs,
      startedAt: entry.startedAt,
    });
  };

  context.on("requestfinished", (request) => finalize(request, null));
  context.on("requestfailed", (request) =>
    finalize(request, (request.failure()?.errorText ?? "request failed").slice(0, 500)),
  );

  return {
    finish: () => {
      // Flush before setting `finished`, or the flush would filter itself out.
      for (const [request, entry] of pending) {
        // Only requests with NO response at all. A long-lived stream (SSE, a hanging poll) has
        // its status and simply never completes; reporting those as unanswered would make every
        // healthy run look broken.
        if (entry.status !== null) continue;
        observed.push({
          stepIndex: entry.stepIndex,
          method: request.method(),
          url: request.url().slice(0, 2000),
          resourceType: request.resourceType(),
          status: null,
          failureText: UNANSWERED,
          durationMs: Date.now() - entry.startMs,
          ttfbMs: null,
          startedAt: entry.startedAt,
        });
      }
      pending.clear();
      finished = true;
      return selectNetworkEvents(observed);
    },
    truncated: () => truncated,
  };
}
