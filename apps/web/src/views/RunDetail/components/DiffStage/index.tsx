import type { CheckpointView } from "@varys/review-contract";
import { Layers } from "@varys/ui";
import { ZoomableImage } from "../../../../components/ZoomableImage";
import styles from "./styles.module.scss";

export type DiffMode = "side-by-side" | "diff-highlight" | "swipe" | "onion";

function Frame({ src, label, alt }: { src: string | null; label: string; alt: string }) {
  return (
    <div className={styles.frame}>
      <span className={styles.label} data-tone={label === "Actual" ? "actual" : "baseline"}>
        {label}
      </span>
      {src ? (
        <ZoomableImage src={src} alt={alt} imgClassName={styles.img} caption={`${label} · ${alt}`} />
      ) : (
        <div className={styles.missing}>No image</div>
      )}
    </div>
  );
}

export function DiffStage({
  checkpoint: cp,
  mode,
  swipe,
  onion,
}: {
  checkpoint: CheckpointView;
  mode: DiffMode;
  swipe: number;
  onion: number;
}) {
  // First capture — there is no prior baseline to diff against.
  if (cp.reviewState === "pending-baseline") {
    return (
      <div className={styles.stage}>
        <div className={styles.pending}>
          <div className={styles.pendingCard}>
            <span className={styles.pendingIcon}>
              <Layers size={24} />
            </span>
            <div className={styles.pendingTitle}>No baseline yet</div>
            <div className={styles.pendingText}>This is the first capture. Approve it to set the golden baseline.</div>
          </div>
          <Frame src={cp.actualUrl} label="Actual" alt={`${cp.name} actual`} />
        </div>
      </div>
    );
  }

  if (mode === "side-by-side") {
    return (
      <div className={styles.stage}>
        <div className={styles.sideBySide}>
          <Frame src={cp.baselineUrl} label="Baseline" alt={`${cp.name} baseline`} />
          <Frame src={cp.actualUrl} label="Actual" alt={`${cp.name} actual`} />
        </div>
      </div>
    );
  }

  if (mode === "diff-highlight") {
    return (
      <div className={styles.stage}>
        <Frame src={cp.diffUrl ?? cp.actualUrl} label="Diff" alt={`${cp.name} diff highlight`} />
      </div>
    );
  }

  // swipe / onion — overlay the actual over the baseline (same capture dimensions).
  const actualStyle =
    mode === "swipe"
      ? { clipPath: `inset(0 ${100 - swipe}% 0 0)` }
      : { opacity: onion / 100 };

  return (
    <div className={styles.stage}>
      <div className={styles.overlay}>
        <span className={styles.label} data-tone="baseline">
          Baseline
        </span>
        {cp.baselineUrl ? <img className={styles.base} src={cp.baselineUrl} alt={`${cp.name} baseline`} /> : null}
        {cp.actualUrl ? <img className={styles.actual} style={actualStyle} src={cp.actualUrl} alt={`${cp.name} actual`} /> : null}
        {mode === "swipe" && (
          <div className={styles.divider} style={{ left: `${swipe}%` }}>
            <span className={styles.handle} />
          </div>
        )}
      </div>
    </div>
  );
}
