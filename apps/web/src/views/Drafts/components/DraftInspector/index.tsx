import type { DraftSummary } from "@varys/review-contract";
import { AlertTriangle, Badge, Button, Check, Eye, IconButton, Pencil, Play, Skeleton, Trash } from "@varys/ui";
import { useEffect, useState } from "react";
import { ZoomableImage } from "../../../../components/ZoomableImage";
import { useToast } from "../../../../context/toast";
import { relativeTime } from "../../../../lib/format";
import { useDraft, useRenameDraft } from "../../../../queries";
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

  const { toast } = useToast();
  const rename = useRenameDraft();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  // Drop out of edit mode when a different draft is selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on selection change.
  useEffect(() => setEditing(false), [draft.id]);

  function startRename() {
    setValue(draft.name);
    setEditing(true);
  }

  function commitRename() {
    const name = value.trim();
    setEditing(false);
    if (!name || name === draft.name) return;
    rename.mutate(
      { id: draft.id, name },
      {
        onSuccess: () => toast(`Renamed to “${name}”`),
        onError: (e) => toast(e instanceof Error ? e.message : "Rename failed"),
      },
    );
  }

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        {editing ? (
          // biome-ignore lint/a11y/noAutofocus: entering rename should focus the field immediately.
          <input
            autoFocus
            className={styles.nameInput}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label="Test name"
          />
        ) : (
          <h2 className={styles.name}>
            {draft.name}
            <IconButton
              variant="ghost"
              size="sm"
              icon={<Pencil size={14} />}
              label="Rename test"
              className={styles.renameBtn}
              onClick={startRename}
            />
          </h2>
        )}
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
                        <ZoomableImage
                          src={cp.previewUrl}
                          alt={`Preview of “${cp.name}”`}
                          caption={cp.name}
                          className={styles.previewZoom}
                        />
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
