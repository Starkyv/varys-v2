import { cx } from "../../utils/cx";
import styles from "./Card.module.scss";
import type { CardHeaderProps, CardProps } from "./Card.types";

/**
 * Card — the elevated white surface the dashboard is built from. Compose with
 * `CardHeader` for the icon + title + actions row.
 *
 *   <Card>
 *     <CardHeader icon={<ChartIcon />} title="Sales Overview" actions={<Button…/>} />
 *     …
 *   </Card>
 */
export function Card({ padded = true, interactive = false, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cx(styles.card, !padded && styles.flush, interactive && styles.interactive, className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ icon, title, actions, className, ...rest }: CardHeaderProps) {
  return (
    <div className={cx(styles.header, className)} {...rest}>
      {icon && <span className={styles.icon}>{icon}</span>}
      <h3 className={styles.title}>{title}</h3>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
