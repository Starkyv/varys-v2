import { STREAM_IDLE_DEFAULTS, streamIdleExpression } from "@varys/step-schema";
import type { Page, Request } from "playwright";

/**
 * "Wait until the content has finished arriving" — the gate a checkpoint on generated content
 * (a Wisdom answer, a Brief, a chart that draws after its data lands) sits behind.
 *
 * The in-page half ({@link streamIdleExpression}, which lives in step-schema beside the schema
 * that defines the primitive) watches the DOM: quiet for `quietMs`, with no rendered loading
 * marker left. That is necessary but not sufficient, and the gap is exactly what made this wait
 * unreliable against a streaming answer:
 *
 *   The DOM half can only see EFFECTS. A stream that pauses — the model is thinking, a tool call
 *   is running, the next chunk has not arrived — produces no mutations and no loading marker, so
 *   after `graceMs` the page looks settled and the wait returns MID-ANSWER. The checkpoint then
 *   captures half a notebook.
 *
 * So this adds the half the page cannot express: the request itself. An NDJSON/SSE answer is one
 * long-lived `fetch` whose `requestfinished` fires when the body ENDS — while it is open, the
 * stream is by definition still going, pause or no pause. The wait alternates between draining
 * in-flight app requests (xhr/fetch/eventsource) and settling the DOM, and only returns when both
 * are quiet at the same time.
 *
 * Best-effort throughout: it returns at `timeoutMs` whatever the page is doing, because a wait
 * that fails a step is a worse failure mode than a wait that gives up.
 */

/** Request kinds that mean "the app is fetching something", as opposed to page furniture. */
const APP_REQUEST_TYPES = new Set(["xhr", "fetch", "eventsource"]);

/**
 * How far back a still-open request counts as work this wait should hold for.
 *
 * The request the wait cares about was started by the PREVIOUS step (the click that submitted
 * the question), so it is already open by the time the wait begins — "started during the wait"
 * would miss the only request that matters. But a connection the app has been holding since page
 * load (a notifications channel, a long poll) must not wedge the wait forever. The line between
 * them is age.
 */
const OPEN_REQUEST_LOOKBACK_MS = 15_000;

/** In-flight app requests for one page, observed from the moment the page is created. */
export interface InFlightTracker {
  /** Open app requests that started no earlier than `since` (epoch ms). */
  openCount(since: number): number;
  /** When an app request last completed (epoch ms; 0 if none has). */
  lastSettledAt(): number;
}

/**
 * Observation must start with the PAGE, not with the wait: a wait that subscribes when it begins
 * has already missed the `request` event for the stream it exists to wait for (Playwright emits
 * it the moment `fetch` is called, which is during the click step). One tracker per page, kept in
 * a WeakMap so it is installed once and collected with the page.
 */
const trackers = new WeakMap<Page, InFlightTracker>();

export function trackInFlightRequests(page: Page): InFlightTracker {
  const existing = trackers.get(page);
  if (existing) return existing;

  const startedAt = new Map<Request, number>();
  let settledAt = 0;
  const onRequest = (req: Request) => {
    if (APP_REQUEST_TYPES.has(req.resourceType())) startedAt.set(req, Date.now());
  };
  const onDone = (req: Request) => {
    if (startedAt.delete(req)) settledAt = Date.now();
  };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  // A closed page keeps nothing alive; drop the map so a long session can't accumulate entries
  // for requests Chromium never reported the end of.
  page.on("close", () => startedAt.clear());

  const tracker: InFlightTracker = {
    openCount: (since) => {
      let n = 0;
      for (const t of startedAt.values()) if (t >= since) n += 1;
      return n;
    },
    lastSettledAt: () => settledAt,
  };
  trackers.set(page, tracker);
  return tracker;
}

export interface StreamIdleOptions {
  quietMs?: number;
  timeoutMs?: number;
  busySelector?: string;
}

export async function waitForStreamIdle(page: Page, opts?: StreamIdleOptions): Promise<void> {
  const quietMs = opts?.quietMs ?? STREAM_IDLE_DEFAULTS.quietMs;
  const timeoutMs = opts?.timeoutMs ?? STREAM_IDLE_DEFAULTS.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  // Requests older than this were not started by the step we are waiting on.
  const since = Date.now() - OPEN_REQUEST_LOOKBACK_MS;
  const tracker = trackInFlightRequests(page);
  const waitStart = Date.now();

  for (;;) {
    // 1. Hold while the app has a request open — including a stream that is mid-pause.
    while (tracker.openCount(since) > 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;

    // 2. Nothing in flight: let the DOM finish rendering what just arrived.
    // A request completed since the wait began ⇒ work happened and is over, so the DOM half
    // does not need its own "did anything async ever start?" grace window: quiet is enough.
    const sawWork = tracker.lastSettledAt() >= waitStart;
    await page
      .evaluate(
        streamIdleExpression({
          quietMs,
          timeoutMs: remaining,
          busySelector: opts?.busySelector,
          sawWork,
        }),
      )
      .catch(() => undefined);

    // 3. Both halves quiet at once, or the cap. A request that opened while the DOM was
    //    settling (the next turn of a stream, a follow-up fetch) sends us round again.
    if (Date.now() >= deadline) return;
    if (tracker.openCount(since) === 0 && Date.now() - tracker.lastSettledAt() >= quietMs) return;
  }
}
