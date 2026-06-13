import "@varys/ui/styles.scss";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { RouteOutlet } from "./app/RouteOutlet";
import { AppProviders } from "./context";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppProviders>
        <AppShell>
          <RouteOutlet />
        </AppShell>
      </AppProviders>
    </StrictMode>,
  );
}
