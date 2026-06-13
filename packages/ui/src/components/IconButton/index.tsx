import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

export type IconButtonVariant = "secondary" | "ghost";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** The icon to render. */
  icon: ReactNode;
  /** Accessible label — required, since there is no visible text. */
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
}

/**
 * IconButton — a square, icon-only control (toolbar actions, back buttons, the
 * top-bar bell/menu). Always labelled for assistive tech.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = "secondary", size = "md", type = "button", className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(styles.iconButton, styles[variant], styles[size], className)}
      {...rest}
    >
      <span className={styles.icon}>{icon}</span>
    </button>
  );
});
