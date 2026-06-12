import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DiffViewer } from "./DiffViewer";
import { NeedsReviewList } from "./NeedsReviewList";

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

function App() {
  const runId = runIdFromLocation();
  return runId ? <DiffViewer runId={runId} /> : <NeedsReviewList />;
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
