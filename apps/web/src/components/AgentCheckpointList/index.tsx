import type { DraftCheckpointPreview } from "@varys/review-contract";
import { Eye } from "@varys/ui";
import { ZoomableImage } from "../ZoomableImage";
import styles from "./styles.module.scss";

/**
 * An **Agent-Driven Test**'s Checkpoints, in journey order, each beside the capture proving the
 * state was reached.
 *
 * Shared by the two places a reviewer meets them — the Drafts inspector, and the Author page
 * watching a Draft being written — because they are the same act of reading. Someone who reviews a
 * journey while Claude writes it and then opens it in the queue should not have to re-learn the
 * layout, and two copies of this would drift the moment either grew a field.
 *
 * The shape says what is being judged. A pinned checkpoint is a picture, and the picture IS the
 * assertion. Here the assertion is the prose — how a run reaches the state, and what counts as
 * matching its baseline — so the prose takes the width and the capture sits beside it as evidence
 * that the state is reachable at all.
 *
 * Numbered because the journey is cumulative: each Checkpoint's instructions continue from where
 * the previous one left the app, so the order is load-bearing rather than a display choice.
 */
export function AgentCheckpointList({ checkpoints }: { checkpoints: DraftCheckpointPreview[] }) {
  return (
    <ol className={styles.list}>
      {checkpoints.map((cp, i) => (
        <li key={cp.name} className={styles.item}>
          <div className={styles.shot}>
            {cp.previewUrl ? (
              <ZoomableImage
                src={cp.previewUrl}
                alt={`What Claude saw at “${cp.name}”`}
                caption={cp.name}
                className={styles.zoom}
              />
            ) : (
              <span className={styles.missing}>
                <Eye size={16} />
                no capture
              </span>
            )}
          </div>
          <div className={styles.body}>
            <div className={styles.name}>
              <span className={styles.step}>{i + 1}</span>
              {cp.name}
            </div>
            {cp.instructions && (
              <div className={styles.field}>
                <span className={styles.fieldLabel}>How to get here</span>
                <p className={styles.fieldText}>{cp.instructions}</p>
              </div>
            )}
            {cp.comparePrompt && (
              <div className={styles.field}>
                <span className={styles.fieldLabel}>What counts as matching</span>
                <p className={styles.fieldText}>{cp.comparePrompt}</p>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
