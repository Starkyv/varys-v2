import styles from "./styles.module.scss";

/** A pulsing "live" dot + label — used by the polled history views. */
export function LiveIndicator({ label = "Live" }: { label?: string }) {
  return (
    <span className={styles.live}>
      <span className={styles.dot} />
      {label}
    </span>
  );
}
