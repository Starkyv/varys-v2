import { cx, Skeleton } from "@varys/ui";
import { useRouter } from "../../../../context/router";
import { StatusBadge } from "../../../../lib/status";
import { useSuiteRun } from "../../../../queries";
import styles from "./styles.module.scss";

export function SuiteRunReportPanel({ id }: { id: string }) {
  const report = useSuiteRun(id);
  const { navigate } = useRouter();

  if (report.isLoading || !report.data) {
    return <Skeleton height={300} radius="var(--radius-xl)" />;
  }

  const r = report.data;
  const c = r.counts;
  const tiles = [
    { label: "Passed", value: c.passed, cls: styles.passed },
    { label: "Review", value: c.needsReview, cls: styles.review },
    { label: "Failed", value: c.failed, cls: styles.failed },
    { label: "Running", value: c.running, cls: styles.neutral },
    { label: "Queued", value: c.queued, cls: styles.neutralMuted },
  ];

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <div className={styles.headTop}>
          <div className={styles.headText}>
            <div className={styles.name}>{r.suiteName}</div>
            <div className={styles.sub}>
              {r.environments.join(" · ")} · {c.total} child runs
            </div>
          </div>
          <StatusBadge status={r.status} />
        </div>
        <div className={styles.tiles}>
          {tiles.map((t) => (
            <div key={t.label} className={cx(styles.tile, t.cls)}>
              <div className={styles.tileValue}>{t.value}</div>
              <div className={styles.tileLabel}>{t.label}</div>
            </div>
          ))}
        </div>
      </div>
      <div className={styles.children}>
        {r.children.map((child) => (
          <button
            key={child.runId}
            type="button"
            className={styles.child}
            onClick={() => navigate({ name: "runDetail", runId: child.runId })}
          >
            <span className={styles.childName}>{child.testName}</span>
            <span className={styles.childEnv}>{child.environment}</span>
            <StatusBadge status={child.status} />
          </button>
        ))}
      </div>
    </div>
  );
}
