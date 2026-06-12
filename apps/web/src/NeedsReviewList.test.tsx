import type { NeedsReviewItem } from "@varys/review-contract";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { API_BASE } from "./api";
import { NeedsReviewList } from "./NeedsReviewList";
import { renderWithClient } from "./test/render";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const items: NeedsReviewItem[] = [
  {
    runId: "run-a",
    testName: "Checkout page",
    environment: "default",
    runTimestamp: "2026-06-12T10:00:00.000Z",
    checkpointName: "hero",
    reviewState: "diff",
  },
  {
    runId: "run-b",
    testName: "Login page",
    environment: "staging",
    runTimestamp: "2026-06-12T09:00:00.000Z",
    checkpointName: "form",
    reviewState: "pending-baseline",
  },
];

describe("NeedsReviewList", () => {
  it("lists each checkpoint with context and a link into the viewer", async () => {
    server.use(http.get(`${API_BASE}/runs/needs-review`, () => HttpResponse.json(items)));

    renderWithClient(<NeedsReviewList />);

    const links = await screen.findAllByRole("link");
    expect(links).toHaveLength(2);

    // Context per entry.
    expect(screen.getByText("Checkout page")).toBeInTheDocument();
    expect(screen.getByText("hero")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();

    // The review reason is spelled out.
    expect(screen.getByText(/visual diff/i)).toBeInTheDocument();
    expect(screen.getByText(/awaiting first approval/i)).toBeInTheDocument();

    // Clicking opens that run in the viewer (same-origin deep link).
    expect(screen.getByRole("link", { name: /checkout page/i })).toHaveAttribute(
      "href",
      "?run=run-a",
    );
  });

  it("shows an empty state when nothing needs review", async () => {
    server.use(http.get(`${API_BASE}/runs/needs-review`, () => HttpResponse.json([])));

    renderWithClient(<NeedsReviewList />);

    expect(await screen.findByText(/nothing needs review/i)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows a loading state before the queue resolves", () => {
    server.use(http.get(`${API_BASE}/runs/needs-review`, () => HttpResponse.json(items)));

    renderWithClient(<NeedsReviewList />);

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  it("shows an error state when the queue fetch fails", async () => {
    server.use(
      http.get(`${API_BASE}/runs/needs-review`, () => new HttpResponse(null, { status: 500 })),
    );

    renderWithClient(<NeedsReviewList />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
