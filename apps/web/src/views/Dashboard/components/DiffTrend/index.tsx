import type { CheckpointTrend } from "@varys/review-contract";
import { Skeleton, TrendingUp } from "@varys/ui";
import { scorePct } from "../../../../lib/format";
import { TONE_VARS } from "../../../../lib/status";
import styles from "./styles.module.scss";

const SKELETON_ROWS = ["a", "b", "c", "d", "e"];
const W = 120;
const H = 32;
const PAD = 4;

/** Scale a diff-score series into an SVG polyline within the 120×32 viewBox.
 *  Normalised to the series' own min/max so the shape reads even for small values;
 *  a higher score sits higher (rising line = drifting worse). */
function toPolyline(points: number[]): string {
  const n = points.length;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  return points
    .map((p, i) => {
      const x = n === 1 ? 0 : i * (W / (n - 1));
      const norm = (p - min) / range;
      const y = H - PAD - norm * (H - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function DiffTrend({
  trends,
  loading,
  error,
  onRetry,
}: {
  trends?: CheckpointTrend[];
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const rows = trends ?? [];
  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <TrendingUp size={18} />
        </span>
        <h3 className={styles.title}>Checkpoint diff trend</h3>
        <span className={styles.window}>14 days</span>
      </header>

      {loading ? (
        <div className={styles.list}>
          {SKELETON_ROWS.map((id) => (
            <div key={id} className={styles.skeletonRow}>
              <Skeleton height={14} width="40%" radius="var(--radius-sm)" />
              <Skeleton height={20} width={120} radius="var(--radius-sm)" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className={styles.state}>
          Couldn’t load diff trends.{" "}
          {onRetry && (
            <button type="button" className={styles.retry} onClick={() => onRetry()}>
              Retry
            </button>
          )}
        </div>
      ) : rows.length === 0 ? (
        <div className={styles.state}>Not enough diff history yet — trends appear once checkpoints rerun.</div>
      ) : (
        <div className={styles.list}>
          {rows.map((t) => (
            <div key={`${t.testName}-${t.checkpointName}`} className={styles.row} title={`${t.testName} · ${t.checkpointName}`}>
              <span className={styles.name}>{t.checkpointName}</span>
              <svg viewBox="0 0 120 32" width="120" height="32" preserveAspectRatio="none" className={styles.spark}>
                <polyline
                  points={toPolyline(t.points)}
                  fill="none"
                  stroke={TONE_VARS[t.tone].base}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className={styles.score} style={{ color: TONE_VARS[t.tone].fg }}>
                {scorePct(t.latestScore)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
