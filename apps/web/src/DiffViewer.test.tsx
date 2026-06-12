import type { RunView } from "@varys/review-contract";
import { screen, waitFor } from "@testing-library/react";
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
      resolution: null,
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
      resolution: null,
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

  it("gates Approve behind a hard-confirm; cancel is a true no-op", async () => {
    let approveCalls = 0;
    server.use(
      http.get(`${API_BASE}/runs/run-1`, () => HttpResponse.json(diffRun)),
      http.post(`${API_BASE}/runs/run-1/checkpoints/hero/approve`, () => {
        approveCalls++;
        return new HttpResponse(null, { status: 201 });
      }),
    );

    renderWithClient(<DiffViewer runId="run-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /approve/i }));

    // The dialog names the irreversible consequence; nothing has been sent yet.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/no undo/i);
    expect(approveCalls).toBe(0);

    // Cancel closes the dialog and sends nothing.
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(approveCalls).toBe(0);

    // Re-open and confirm: now the approve is sent.
    await userEvent.click(screen.getByRole("button", { name: /approve/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm approve/i }));
    await waitFor(() => expect(approveCalls).toBe(1));
  });

  it("rejects without any destructive confirm", async () => {
    let rejectCalls = 0;
    server.use(
      http.get(`${API_BASE}/runs/run-1`, () => HttpResponse.json(diffRun)),
      http.post(`${API_BASE}/runs/run-1/checkpoints/hero/reject`, () => {
        rejectCalls++;
        return new HttpResponse(null, { status: 201 });
      }),
    );

    renderWithClient(<DiffViewer runId="run-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /reject/i }));

    // No dialog stands in the way — the friction matches the (non-destructive) risk.
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(rejectCalls).toBe(1));
  });

  it("renders an already-decided checkpoint without action buttons", async () => {
    const decidedRun: RunView = {
      ...diffRun,
      checkpoints: [{ ...diffRun.checkpoints[0], resolution: "approved" }],
    };
    server.use(http.get(`${API_BASE}/runs/run-1`, () => HttpResponse.json(decidedRun)));

    renderWithClient(<DiffViewer runId="run-1" />);

    expect(await screen.findByText(/already approved/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
  });

  it("surfaces a failed decision and leaves the checkpoint reviewable", async () => {
    server.use(
      http.get(`${API_BASE}/runs/run-1`, () => HttpResponse.json(diffRun)),
      http.post(`${API_BASE}/runs/run-1/checkpoints/hero/approve`, () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );

    renderWithClient(<DiffViewer runId="run-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /approve/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm approve/i }));

    // The error is surfaced and the approve control is still there to retry.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  });
});
