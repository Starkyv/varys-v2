import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  inputSize?: "sm" | "md";
  invalid?: boolean;
  /** Use a monospace face (env values, secret names). */
  mono?: boolean;
  /** Leading adornment (e.g. a search icon); makes the field a wrapped control. */
  leadingIcon?: ReactNode;
}

/**
 * Input — a single-line text field. Optionally takes a leading icon (the top-bar
 * search) and a monospace face (environment variable / secret editors).
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { inputSize = "md", invalid, mono, leadingIcon, className, ...rest },
  ref,
) {
  const field = (
    <input
      ref={ref}
      className={cx(
        styles.input,
        styles[inputSize],
        invalid && styles.invalid,
        mono && styles.mono,
        leadingIcon && styles.hasLeading,
        !leadingIcon && className,
      )}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
  if (!leadingIcon) return field;
  return (
    <div className={cx(styles.wrap, className)}>
      <span className={styles.leadingIcon}>{leadingIcon}</span>
      {field}
    </div>
  );
});
