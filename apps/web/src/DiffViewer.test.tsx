import type { RunView } from "@varys/review-contract";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { API_BASE } from "./api";
import { DiffViewer } from "./DiffViewer";
import { renderWithClient } from "./test/render";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const diffRun: RunView = {
  runId: "run-1",
  status: "needs_review",
  testName: "Checkout page",
  environment: "default",
  runTimestamp: "2026-06-12T10:00:00.000Z",
  checkpoints: [
    {
      name: "hero",
      reviewState: "diff",
      diffScore: 0.12,
      threshold: 0.01,
      healed: false,
      actualUrl: "http://localhost:3000/artifacts/actual",
      baselineUrl: "http://localhost:3000/artifacts/baseline",
      diffUrl: "http://localhost:3000/artifacts/diff",
    },
  ],
};

const seedRun: RunView = {
  runId: "run-seed",
  status: "needs_review",
  testName: "Checkout page",
  environment: "default",
  runTimestamp: "2026-06-12T10:00:00.000Z",
  checkpoints: [
    {
      name: "hero",
      reviewState: "pending-baseline",
      diffScore: null,
      threshold: 0.01,
      healed: false,
      actualUrl: "http://localhost:3000/artifacts/actual",
      baselineUrl: null,
      diffUrl: null,
    },
  ],
};

describe("DiffViewer", () => {
  it("toggles between side-by-side (baseline|actual) and the diff-highlight overlay", async () => {
    server.use(http.get(`${API_BASE}/runs/run-1`, () => HttpResponse.json(diffRun)));

    renderWithClient(<DiffViewer runId="run-1" />);
    const cp = diffRun.checkpoints[0];

    // Default: side-by-side shows baseline + actual, not the diff overlay.
    expect(await screen.findByRole("img", { name: "baseline" })).toHaveAttribute(
      "src",
      cp.baselineUrl,
    );
    expect(screen.getByRole("img", { name: "actual" })).toHaveAttribute("src", cp.actualUrl);
    expect(screen.queryByRole("img", { name: "diff highlight" })).toBeNull();

    // Switch to the overlay: the precomputed diff is shown, baseline/actual are not.
    await userEvent.click(screen.getByRole("button", { name: /diff highlight/i }));
    expect(screen.getByRole("img", { name: "diff highlight" })).toHaveAttribute(
      "src",
      cp.diffUrl,
    );
    expect(screen.queryByRole("img", { name: "baseline" })).toBeNull();

    // ...and back, without re-fetching (same checkpoint).
    await userEvent.click(screen.getByRole("button", { name: /side by side/i }));
    expect(screen.getByRole("img", { name: "baseline" })).toBeInTheDocument();
  });

  it("shows the server-computed verdict metadata (diff score, threshold, healed)", async () => {
    server.use(http.get(`${API_BASE}/runs/run-1`, () => HttpResponse.json(diffRun)));

    renderWithClient(<DiffViewer runId="run-1" />);
    await screen.findByRole("img", { name: "baseline" });

    expect(screen.getByText(/diff score/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.12/)).toBeInTheDocument(); // diffScore
    expect(screen.getByText(/threshold/i)).toBeInTheDocument();
    expect(screen.getByText(/healed/i)).toBeInTheDocument();
  });

  it("shows a loading state before the run resolves", () => {
    server.use(http.get(`${API_BASE}/runs/run-1`, () => HttpResponse.json(diffRun)));

    renderWithClient(<DiffViewer runId="run-1" />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("shows an error state when the fetch fails", async () => {
    server.use(
      http.get(`${API_BASE}/runs/run-1`, () => new HttpResponse(null, { status: 500 })),
    );

    renderWithClient(<DiffViewer runId="run-1" />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("renders a first-seed checkpoint as a candidate baseline with no diff", async () => {
    server.use(http.get(`${API_BASE}/runs/run-seed`, () => HttpResponse.json(seedRun)));

    renderWithClient(<DiffViewer runId="run-seed" />);

    // The captured actual is shown as the candidate baseline...
    expect(await screen.findByRole("img", { name: "actual" })).toHaveAttribute(
      "src",
      seedRun.checkpoints[0].actualUrl,
    );
    // ...with a first-approval affordance and nothing to diff against.
    expect(screen.getByRole("status")).toHaveTextContent(/first approval/i);
    expect(screen.queryByRole("img", { name: "baseline" })).toBeNull();
    expect(screen.queryByRole("img", { name: "diff highlight" })).toBeNull();
    // No overlay control — there is no diff to switch to.
    expect(screen.queryByRole("button", { name: /diff highlight/i })).toBeNull();
  });
});
