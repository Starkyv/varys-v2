import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * Switch — an on/off toggle (the run dialog's "Keep Playwright trace"). Rendered
 * as `role="switch"`; the track + thumb animate between states.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cx(styles.switch, checked && styles.on, className)}
      {...rest}
    >
      <span className={styles.thumb} aria-hidden />
    </button>
  );
});
