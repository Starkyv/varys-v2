import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DiffViewer } from "./DiffViewer";

const queryClient = new QueryClient();

/** Deep link: a run is opened at `/runs/<id>` (path) or `?run=<id>` (query). */
export function runIdFromLocation(loc: Location = window.location): string | null {
  const m = loc.pathname.match(/\/runs\/([^/?#]+)/);
  if (m) return m[1];
  return new URLSearchParams(loc.search).get("run");
}

function App() {
  const runId = runIdFromLocation();
  if (!runId) {
    return (
      <p style={{ fontFamily: "system-ui", padding: 16 }}>
        Open a run at <code>/runs/&lt;id&gt;</code>.
      </p>
    );
  }
  return <DiffViewer runId={runId} />;
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
