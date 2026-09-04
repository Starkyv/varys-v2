import type { SuiteRunCounts } from "@varys/review-contract";
import styles from "./styles.module.scss";

/** `healed` is deliberately NOT a segment: healed children are already inside `passed`, so
 *  drawing it would over-count the bar. It rides along as a caption instead. */
const SEGMENTS: { key: keyof SuiteRunCounts; color: string; label: string }[] = [
  { key: "passed", color: "var(--color-success)", label: "passed" },
  { key: "needsReview", color: "var(--color-warning)", label: "need review" },
  { key: "failed", color: "var(--color-danger)", label: "failed" },
  { key: "running", color: "var(--color-neutral-400)", label: "running" },
  { key: "queued", color: "var(--color-neutral-200)", label: "queued" },
];

/**
 * The child-outcome mix of one fan-out, as a stacked bar. The whole point of a suite run is
 * "how much of it is green", and that is a proportion — a number per status makes you do the
 * arithmetic, a bar does not. The counts stay beside it for the exact figures.
 */
export function CountsBar({ counts, width }: { counts: SuiteRunCounts; width?: number }) {
  const segs = SEGMENTS.filter((s) => counts[s.key] > 0);
  const title = segs.map((s) => `${counts[s.key]} ${s.label}`).join(" · ") || "no child runs";

  return (
    <div className={styles.wrap} style={width ? { width } : undefined} title={title}>
      <div className={styles.bar} role="img" aria-label={title}>
        {segs.map((s) => (
          <span
            key={s.key}
            style={{ width: `${(counts[s.key] / counts.total) * 100}%`, background: s.color }}
          />
        ))}
      </div>
      <div className={styles.caption}>
        {counts.total} run{counts.total === 1 ? "" : "s"}
        {counts.failed > 0 && <span className={styles.failed}> · {counts.failed} failed</span>}
        {counts.needsReview > 0 && <span className={styles.review}> · {counts.needsReview} to review</span>}
        {/* A healed child is counted inside `passed`, so it never moves the bar — but it is the
            one thing a green suite can be hiding, so it is always spelled out. */}
        {counts.healed > 0 && <span className={styles.review}> · {counts.healed} healed</span>}
      </div>
    </div>
  );
}
