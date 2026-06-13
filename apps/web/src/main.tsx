import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DiffViewer } from "./DiffViewer";
import { EnvironmentsList } from "./EnvironmentsList";
import { NeedsReviewList } from "./NeedsReviewList";
import { RunsList } from "./RunsList";
import { SuiteRunReport } from "./SuiteRunReport";
import { SuitesList } from "./SuitesList";
import { TestsList } from "./TestsList";

const queryClient = new QueryClient();

/**
 * Deep link: a run is opened at `?run=<id>` (query) — the same-origin form that
 * works behind the dev proxy / prod ingress without colliding with the API's own
 * `/runs/:id`. The `/runs/<id>` path form is also accepted for a split-origin
 * deploy (where the API lives on a different host).
 */
export function runIdFromLocation(loc: Location = window.location): string | null {
  const fromQuery = new URLSearchParams(loc.search).get("run");
  if (fromQuery) return fromQuery;
  const m = loc.pathname.match(/\/runs\/([^/?#]+)/);
  return m ? m[1] : null;
}

type Tab = "review" | "runs" | "tests" | "suites" | "environments";

function Nav({ active }: { active: Tab }) {
  const link = (on: boolean) => ({
    textDecoration: "none",
    fontWeight: on ? 700 : 400,
    color: on ? "#111" : "#1f6feb",
  });
  return (
    <nav
      style={{
        fontFamily: "system-ui, Arial, sans-serif",
        display: "flex",
        gap: 16,
        padding: "12px 16px",
        borderBottom: "1px solid #eee",
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <a href="/" style={link(active === "review")}>
        Needs review
      </a>
      <a href="?view=runs" style={link(active === "runs")}>
        Runs
      </a>
      <a href="?view=tests" style={link(active === "tests")}>
        Tests
      </a>
      <a href="?view=suites" style={link(active === "suites")}>
        Suites
      </a>
      <a href="?view=environments" style={link(active === "environments")}>
        Environments
      </a>
    </nav>
  );
}

function App() {
  const runId = runIdFromLocation();
  if (runId) return <DiffViewer runId={runId} />;

  // Suite-run report deep link (`?suiteRun=<id>`) — same pattern as `?run=`.
  const suiteRunId = new URLSearchParams(window.location.search).get("suiteRun");
  if (suiteRunId) return <SuiteRunReport suiteRunId={suiteRunId} />;

  const view = new URLSearchParams(window.location.search).get("view");
  const tab: Tab =
    view === "tests"
      ? "tests"
      : view === "suites"
        ? "suites"
        : view === "environments"
          ? "environments"
          : view === "runs"
            ? "runs"
            : "review";
  return (
    <>
      <Nav active={tab} />
      {tab === "tests" ? (
        <TestsList />
      ) : tab === "suites" ? (
        <SuitesList />
      ) : tab === "environments" ? (
        <EnvironmentsList />
      ) : tab === "runs" ? (
        <RunsList />
      ) : (
        <NeedsReviewList />
      )}
    </>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
