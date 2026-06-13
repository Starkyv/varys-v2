import { forwardRef } from "react";
import { cx } from "../../utils/cx";
import styles from "./Button.module.scss";
import type { ButtonProps } from "./Button.types";

/**
 * Button — the primary interactive control. Four variants (primary / secondary /
 * ghost / danger), three sizes, optional icons and a loading state.
 *
 *   <Button variant="primary">Run test</Button>
 *   <Button variant="secondary" iconLeft={<ChevronDown />}>Monthly</Button>
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    fullWidth = false,
    loading = false,
    iconLeft,
    iconRight,
    disabled,
    className,
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        styles.button,
        styles[variant],
        styles[size],
        fullWidth && styles.fullWidth,
        loading && styles.loading,
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className={styles.spinner} aria-hidden />
      ) : (
        iconLeft && <span className={styles.icon}>{iconLeft}</span>
      )}
      {children}
      {iconRight && !loading && <span className={styles.icon}>{iconRight}</span>}
    </button>
  );
});
