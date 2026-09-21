import type { CheckpointView } from "@varys/review-contract";
import { AlertTriangle, Layers } from "@varys/ui";
import { ZoomableImage } from "../../../../components/ZoomableImage";
import styles from "./styles.module.scss";

export type DiffMode = "side-by-side" | "diff-highlight" | "swipe" | "onion";

function Frame({
  src,
  label,
  alt,
  gallery,
}: {
  src: string | null;
  label: string;
  alt: string;
  gallery?: { src: string; label: string }[];
}) {
  return (
    <div className={styles.frame}>
      <span className={styles.label} data-tone={label === "Actual" ? "actual" : "baseline"}>
        {label}
      </span>
      {src ? (
        <ZoomableImage src={src} alt={alt} imgClassName={styles.img} caption={`${label} · ${alt}`} gallery={gallery} />
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
  gallery,
}: {
  checkpoint: CheckpointView;
  mode: DiffMode;
  swipe: number;
  onion: number;
  /** Run-wide ordered images for the lightbox's arrow-key traversal. */
  gallery?: { src: string; label: string }[];
}) {
  // Unreached — the run never filled this slot, so there is no capture to stage at all. Checked
  // before every other branch, which all assume an actual image exists.
  if (cp.reviewState === "missing") {
    return (
      <div className={styles.stage}>
        <div className={styles.pending}>
          <div className={styles.pendingCard}>
            <span className={styles.unreachedIcon}>
              <AlertTriangle size={24} />
            </span>
            <div className={styles.pendingTitle}>Never reached</div>
            <div className={styles.pendingText}>
              The run was expected to capture this checkpoint and never did, so nothing was compared
              here. This failed the run.
            </div>
          </div>
        </div>
      </div>
    );
  }

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
          <Frame src={cp.actualUrl} label="Actual" alt={`${cp.name} actual`} gallery={gallery} />
        </div>
      </div>
    );
  }

  if (mode === "side-by-side") {
    return (
      <div className={styles.stage}>
        <div className={styles.sideBySide}>
          <Frame src={cp.baselineUrl} label="Baseline" alt={`${cp.name} baseline`} gallery={gallery} />
          <Frame src={cp.actualUrl} label="Actual" alt={`${cp.name} actual`} gallery={gallery} />
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
