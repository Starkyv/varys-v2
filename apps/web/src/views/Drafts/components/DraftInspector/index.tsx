import type { DraftSummary } from "@varys/review-contract";
import { AlertTriangle, Badge, Button, Check, Eye, Pencil, Play, Skeleton, Trash } from "@varys/ui";
import { relativeTime } from "../../../../lib/format";
import { useDraft } from "../../../../queries";
import styles from "./styles.module.scss";

/**
 * The review-queue inspector — the right pane of the master-detail. Shows the selected
 * draft in enough depth to judge it without leaving the queue: steering intent, a
 * zero-checkpoint warning, what it visually asserts (the authoring-preview screenshots
 * Claude captured, via GET /drafts/:id), and the review actions. Recreated from the
 * Claude Design review-queue mock.
 */
export function DraftInspector({
  draft,
  onPromote,
  onDiscard,
  onRunPreview,
  onOpenEditor,
}: {
  draft: DraftSummary;
  onPromote: () => void;
  onDiscard: () => void;
  onRunPreview: () => void;
  onOpenEditor: () => void;
}) {
  // Per-checkpoint authoring previews — fetched only for the selected draft.
  const detail = useDraft(draft.id);
  const checkpoints = detail.data?.checkpoints ?? [];
  const zero = draft.checkpointCount === 0;

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <h2 className={styles.name}>{draft.name}</h2>
        <div className={styles.tags}>
          <Badge tone="primary" appearance="soft" size="sm">
            AI-authored
          </Badge>
        </div>
      </header>

      <div className={styles.body}>
        {draft.intent ? (
          <div className={styles.intent}>
            <span className={styles.intentLabel}>Steering intent</span>
            <p className={styles.intentText}>{draft.intent}</p>
          </div>
        ) : (
          <div className={styles.noIntent}>
            No steering instruction was recorded. Lean on the checkpoints and steps below to judge
            what this test is meant to verify.
          </div>
        )}

        {zero && (
          <div className={styles.zeroWarn}>
            <AlertTriangle size={18} />
            <div>
              <div className={styles.zeroTitle}>This test asserts nothing</div>
              <p className={styles.zeroText}>
                Zero visual checkpoints — it will run but never catch a regression. You can still
                promote it, but add a checkpoint in the editor first.
              </p>
            </div>
          </div>
        )}

        <div className={styles.metaGrid}>
          <div className={styles.metaCell}>
            <div className={styles.metaLabel}>Checkpoints</div>
            <div className={styles.metaValue}>
              {draft.checkpointCount} checkpoint{draft.checkpointCount === 1 ? "" : "s"}
            </div>
          </div>
          <div className={styles.metaCell}>
            <div className={styles.metaLabel}>Authored</div>
            <div className={styles.metaValue}>{relativeTime(draft.createdAt)}</div>
          </div>
        </div>

        {!zero && (
          <section className={styles.previews}>
            <div className={styles.sectionLabel}>What it asserts</div>
            {detail.isLoading ? (
              <div className={styles.previewGrid}>
                <Skeleton height={132} radius="var(--radius-lg)" />
                <Skeleton height={132} radius="var(--radius-lg)" />
              </div>
            ) : checkpoints.length === 0 ? (
              <div className={styles.previewEmpty}>No checkpoint previews were captured.</div>
            ) : (
              <div className={styles.previewGrid}>
                {checkpoints.map((cp) => (
                  <figure key={cp.name} className={styles.preview}>
                    <div className={styles.previewImage}>
                      {cp.previewUrl ? (
                        <img src={cp.previewUrl} alt={`Preview of “${cp.name}”`} />
                      ) : (
                        <span className={styles.previewMissing}>
                          <Eye size={18} />
                          no preview
                        </span>
                      )}
                      <span className={styles.previewMode}>{cp.captureMode}</span>
                    </div>
                    <figcaption className={styles.previewName}>{cp.name}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      <footer className={styles.footer}>
        <Button variant="ghost" iconLeft={<Trash size={15} />} className={styles.discard} onClick={onDiscard}>
          Discard
        </Button>
        <span className={styles.footSpacer} />
        <Button variant="secondary" iconLeft={<Pencil size={15} />} onClick={onOpenEditor}>
          Open editor
        </Button>
        <Button variant="secondary" iconLeft={<Play size={14} />} onClick={onRunPreview}>
          Run preview
        </Button>
        <Button variant="primary" iconLeft={<Check size={15} />} onClick={onPromote}>
          Promote
        </Button>
      </footer>
    </div>
  );
}
