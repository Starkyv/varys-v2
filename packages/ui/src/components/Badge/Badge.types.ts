import type { HTMLAttributes, ReactNode } from "react";
import type { Intent } from "../../types";

export type BadgeAppearance = "soft" | "solid" | "outline";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Color intent — maps to the semantic status tokens. */
  tone?: Intent;
  /** soft (tinted bg, default — the dashboard delta badges), solid, or outline. */
  appearance?: BadgeAppearance;
  size?: "sm" | "md";
  /** Show a leading status dot. */
  dot?: boolean;
  /** Leading adornment (e.g. a trend arrow icon). */
  icon?: ReactNode;
}
