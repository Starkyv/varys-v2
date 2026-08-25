import "@varys/ui/styles.scss";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { RouteOutlet } from "./app/RouteOutlet";
import { SessionGate } from "./app/SessionGate";
import { AppProviders } from "./context";
import { installUnauthorizedRedirect } from "./lib/unauthorized";
import { isMcpAuthorizeRoute, McpAuthorize } from "./views/McpAuthorize";

// A 401 from any API call (expired/absent session) routes back to Login via SessionGate.
installUnauthorizedRedirect();

/**
 * Claude Code's OAuth handoff (`/oauth/authorize`) renders OUTSIDE the app shell: it is a
 * transient bounce back to the authorize endpoint, not a place in the product, so it gets no
 * sidebar or route entry. Still inside <SessionGate>, which is the point — the user signs in
 * with the normal Login screen first, and the handoff then runs as them.
 */
const content = isMcpAuthorizeRoute() ? (
  <McpAuthorize />
) : (
  <AppShell>
    <RouteOutlet />
  </AppShell>
);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppProviders>
        <SessionGate>{content}</SessionGate>
      </AppProviders>
    </StrictMode>,
  );
}
