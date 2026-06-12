import type { TestSummary } from "@varys/review-contract";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { API_BASE } from "./api";
import { TestsList } from "./TestsList";
import { renderWithClient } from "./test/render";

// Default the environments fetch (TestsList loads it for the Run picker) so the
// onUnhandledRequest:"error" guard doesn't trip; individual tests can override.
const server = setupServer(
  http.get(`${API_BASE}/environments`, () => HttpResponse.json([])),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const tests: TestSummary[] = [
  { id: "t-1", name: "Checkout page", createdAt: "2026-06-12T10:00:00.000Z", needsEnvironment: false },
  { id: "t-2", name: "Login page", createdAt: "2026-06-12T09:00:00.000Z", needsEnvironment: false },
];

describe("TestsList", () => {
  it("lists saved tests and runs one on demand", async () => {
    let runBody: unknown = null;
    server.use(
      http.get(`${API_BASE}/tests`, () => HttpResponse.json(tests)),
      http.post(`${API_BASE}/runs`, async ({ request }) => {
        runBody = await request.json();
        return HttpResponse.json({ runId: "run-x" });
      }),
    );

    renderWithClient(<TestsList />);

    expect(await screen.findByText("Checkout page")).toBeInTheDocument();
    expect(screen.getByText("Login page")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: /run/i })[0]);

    await waitFor(() => expect(runBody).toEqual({ testId: "t-1" }));
    expect(await screen.findByText(/run started/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no tests", async () => {
    server.use(http.get(`${API_BASE}/tests`, () => HttpResponse.json([])));

    renderWithClient(<TestsList />);

    expect(await screen.findByText(/no saved tests/i)).toBeInTheDocument();
  });

  it("shows an error state when the tests fetch fails", async () => {
    server.use(
      http.get(`${API_BASE}/tests`, () => new HttpResponse(null, { status: 500 })),
    );

    renderWithClient(<TestsList />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
