import { describe, expect, it } from "vitest";
import {
  isProblem,
  NETWORK_LIMITS,
  type NetworkEvent,
  selectNetworkEvents,
  UNANSWERED,
} from "./network";

function event(over: Partial<NetworkEvent> = {}): NetworkEvent {
  return {
    stepIndex: 0,
    method: "GET",
    url: "http://app.test/api/rows",
    resourceType: "fetch",
    status: 200,
    failureText: null,
    durationMs: 10,
    ttfbMs: 5,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

/** `startedAt` n milliseconds after the fixture epoch, so ordering is explicit in each test. */
function at(ms: number): Date {
  return new Date(new Date("2026-01-01T00:00:00Z").getTime() + ms);
}

describe("isProblem — what counts as something to explain a failure with", () => {
  it("treats a transport error as a problem even with no status", () => {
    expect(isProblem(event({ status: null, failureText: "net::ERR_TIMED_OUT" }))).toBe(true);
  });

  it("treats a request the server never answered as a problem", () => {
    // The API-timeout shape: no status, no transport error, simply outstanding at the end.
    expect(isProblem(event({ status: null, failureText: UNANSWERED }))).toBe(true);
  });

  it("treats 4xx and 5xx as problems", () => {
    for (const status of [400, 401, 404, 500, 503]) {
      expect(isProblem(event({ status }))).toBe(true);
    }
  });

  it("does NOT treat a redirect as a problem", () => {
    // Playwright reports each redirect hop as its own request, so counting 3xx would fill the
    // record with ordinary navigation and bury the failures it exists to surface.
    for (const status of [301, 302, 304, 307]) {
      expect(isProblem(event({ status }))).toBe(false);
    }
  });

  it("does not treat a slow success as a problem", () => {
    expect(isProblem(event({ durationMs: 45_000 }))).toBe(false);
  });
});

describe("selectNetworkEvents — the bounded record", () => {
  it("keeps every problem and drops unremarkable successes", () => {
    const kept = selectNetworkEvents([
      event({ startedAt: at(0), status: 200, url: "/api/a" }),
      event({ startedAt: at(1), status: 500, url: "/api/b" }),
      event({ startedAt: at(2), status: 200, url: "/api/c" }),
    ]);
    // Both successes survive here only because they fit under maxSlow; the 500 is unconditional.
    expect(kept.map((e) => e.url)).toContain("/api/b");
  });

  it("keeps the SLOWEST successes when there are more than the cap", () => {
    const many = Array.from({ length: NETWORK_LIMITS.maxSlow + 30 }, (_, i) =>
      event({ startedAt: at(i), durationMs: i, url: `/api/${i}` }),
    );
    const kept = selectNetworkEvents(many);
    expect(kept).toHaveLength(NETWORK_LIMITS.maxSlow);
    // The slowest are the highest-indexed by construction.
    const slowest = many.slice(-NETWORK_LIMITS.maxSlow).map((e) => e.url);
    expect(kept.map((e) => e.url).sort()).toEqual(slowest.sort());
  });

  it("keeps the FIRST problems, not the last, when there are more than the cap", () => {
    // When an app's API goes down mid-run, every later request fails too. The row that explains
    // the run is the first one, so the cap must not evict it in favour of the tail.
    const problems = Array.from({ length: NETWORK_LIMITS.maxProblems + 5 }, (_, i) =>
      event({ startedAt: at(i), status: 500, url: `/api/${i}` }),
    );
    const kept = selectNetworkEvents(problems);
    expect(kept).toHaveLength(NETWORK_LIMITS.maxProblems);
    expect(kept[0].url).toBe("/api/0");
    expect(kept.map((e) => e.url)).not.toContain(`/api/${NETWORK_LIMITS.maxProblems + 4}`);
  });

  it("returns everything in START order, so it reads as the run's own timeline", () => {
    const kept = selectNetworkEvents([
      event({ startedAt: at(300), status: 500, url: "/api/late-failure" }),
      event({ startedAt: at(100), durationMs: 9_000, url: "/api/slow" }),
      event({ startedAt: at(200), status: 404, url: "/api/missing" }),
    ]);
    expect(kept.map((e) => e.url)).toEqual(["/api/slow", "/api/missing", "/api/late-failure"]);
  });

  it("keeps problems even when the success cap would have excluded them on duration", () => {
    // A 500 usually returns FAST, so ranking by duration would throw away the most diagnostic
    // row in the run. Problems are never ranked against successes.
    const fastFailure = event({ startedAt: at(0), status: 500, durationMs: 2, url: "/api/down" });
    const slowSuccesses = Array.from({ length: NETWORK_LIMITS.maxSlow + 10 }, (_, i) =>
      event({ startedAt: at(i + 1), durationMs: 5_000 + i, url: `/api/ok-${i}` }),
    );
    const kept = selectNetworkEvents([fastFailure, ...slowSuccesses]);
    expect(kept.map((e) => e.url)).toContain("/api/down");
    expect(kept).toHaveLength(NETWORK_LIMITS.maxSlow + 1);
  });

  it("preserves the step each request was attributed to", () => {
    const kept = selectNetworkEvents([
      event({ startedAt: at(0), stepIndex: 3, status: 500 }),
      event({ startedAt: at(1), stepIndex: null, status: 401 }),
    ]);
    expect(kept.map((e) => e.stepIndex)).toEqual([3, null]);
  });
});
