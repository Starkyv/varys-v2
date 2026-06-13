import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Size } from "../../types";

export type ButtonVariant =
  | "primary" // filled brand violet — main CTA
  | "secondary" // white surface + border — the dashboard's Filter/Sort/Export
  | "ghost" // transparent — toolbar / icon actions
  | "danger"; // destructive (reject, irreversible approve)

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  variant?: ButtonVariant;
  size?: Size;
  /** Stretch to the container width. */
  fullWidth?: boolean;
  /** Show a spinner and block interaction (stays focusable, marked busy). */
  loading?: boolean;
  /** Leading / trailing adornment (icon). */
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
}
