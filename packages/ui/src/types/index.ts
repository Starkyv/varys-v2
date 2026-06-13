/**
 * Shared prop types for the design system.
 */

/** Color-mode themes (see themes/light.scss, dark.scss). */
export type ThemeName = "light" | "dark";

/**
 * Brand themes. "nexus" is the default (declared on :root, no `data-brand`);
 * others map to a `[data-brand="…"]` override. Widen as real customers are added.
 */
export type BrandName = "nexus" | "acme" | "globex" | (string & {});

/** Standard control sizing used across interactive components. */
export type Size = "sm" | "md" | "lg";

/** Status/intent vocabulary, aligned with the semantic status tokens. */
export type Intent = "primary" | "neutral" | "success" | "warning" | "danger" | "info";
