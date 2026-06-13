/**
 * @varys/ui — the Varys design system ("Nexus" visual language).
 *
 * Public API surface. Import components/hooks/tokens from here; import the global
 * stylesheet once at the app root:
 *
 *   import "@varys/ui/styles.scss";   // tokens + themes + reset + base styles
 *   import { Button, Card, Badge, useTheme } from "@varys/ui";
 *   import { tokens, dataViz } from "@varys/ui/tokens";   // JS-land values (charts)
 */
export * from "./components";
export * from "./icons";
export * from "./hooks";
export * from "./utils";
export * from "./types";

// Convenience re-export; `@varys/ui/tokens` is the canonical path for JS values.
export { tokens } from "./tokens";
