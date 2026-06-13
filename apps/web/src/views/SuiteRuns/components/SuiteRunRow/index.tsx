import type { SuiteRunSummary } from "@varys/review-contract";
import { cx } from "@varys/ui";
import { relativeTime } from "../../../../lib/format";
import { StatusBadge } from "../../../../lib/status";
import styles from "./styles.module.scss";

const SEGMENTS: { key: keyof SuiteRunSummary["counts"]; color: string }[] = [
  { key: "passed", color: "var(--color-success)" },
  { key: "needsReview", color: "var(--color-warning)" },
  { key: "failed", color: "var(--color-danger)" },
  { key: "running", color: "var(--color-neutral-400)" },
  { key: "queued", color: "var(--color-neutral-200)" },
];

export function SuiteRunRow({
  run,
  selected,
  onSelect,
}: {
  run: SuiteRunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const { counts } = run;
  const segs = SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => ({
    width: `${(counts[s.key] / counts.total) * 100}%`,
    color: s.color,
  }));

  return (
    <button type="button" className={cx(styles.row, selected && styles.selected)} onClick={onSelect}>
      <div className={styles.top}>
        <span className={styles.name}>{run.suiteName}</span>
        <StatusBadge status={run.status} />
      </div>
      <div className={styles.bar}>
        {segs.map((s, i) => (
          <span key={i} style={{ width: s.width, background: s.color }} />
        ))}
      </div>
      <div className={styles.meta}>
        <span className={styles.envs}>{run.environments.join(" · ")}</span>
        <span>
          {counts.total} runs · {relativeTime(run.runTimestamp)}
        </span>
      </div>
    </button>
  );
}
