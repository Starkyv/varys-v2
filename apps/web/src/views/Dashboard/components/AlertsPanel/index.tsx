import { Bell } from "@varys/ui";
import styles from "./styles.module.scss";

/**
 * Alerts (diffs / failures / baseline approvals) are part of the notifications
 * slice (slice 8). The panel stays in the dashboard layout so the grid matches the
 * design; until that slice lands it shows a neutral placeholder rather than mock
 * data.
 */
export function AlertsPanel() {
  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <Bell size={18} />
        </span>
        <h3 className={styles.title}>Alerts</h3>
      </header>
      <div className={styles.empty}>
        <span className={styles.emptyIcon}>
          <Bell size={20} />
        </span>
        <p className={styles.emptyTitle}>No alerts yet</p>
        <p className={styles.emptyText}>
          Diff, failure and baseline-approval alerts arrive with notifications.
        </p>
      </div>
    </section>
  );
}
