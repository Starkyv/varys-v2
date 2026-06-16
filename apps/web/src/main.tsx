import "@varys/ui/styles.scss";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { RouteOutlet } from "./app/RouteOutlet";
import { SessionGate } from "./app/SessionGate";
import { AppProviders } from "./context";
import { installUnauthorizedRedirect } from "./lib/unauthorized";

// A 401 from any API call (expired/absent session) routes back to Login via SessionGate.
installUnauthorizedRedirect();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppProviders>
        <SessionGate>
          <AppShell>
            <RouteOutlet />
          </AppShell>
        </SessionGate>
      </AppProviders>
    </StrictMode>,
  );
}
