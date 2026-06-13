import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Apply the standard card inner padding (default true). */
  padded?: boolean;
  /** Lift + raise the shadow on hover — for cards that act as links. */
  interactive?: boolean;
}

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Leading icon, rendered in a muted square (the dashboard card glyph). */
  icon?: ReactNode;
  /** Title text or node. */
  title: ReactNode;
  /** Right-aligned controls (filters, dropdowns, "See All"). */
  actions?: ReactNode;
}
