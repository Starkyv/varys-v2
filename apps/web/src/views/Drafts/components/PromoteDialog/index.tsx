import type { DraftSummary } from "@varys/review-contract";
import {
  Button,
  Check,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
} from "@varys/ui";
import { useEffect, useId, useState } from "react";
import { useToast } from "../../../../context/toast";
import { useDraft, useFolders, usePromoteDraft } from "../../../../queries";
import styles from "./styles.module.scss";

/**
 * Promote an AI-authored draft into the active corpus — assign a folder + tags and flip
 * it active (suite/schedule eligible). The one human gate on AI output; baseline approval
 * stays the separate per-environment gate. Web-UI only — never an agent tool.
 */
export function PromoteDialog({
  draft,
  open,
  onClose,
}: {
  draft: DraftSummary | null;
  open: boolean;
  onClose: () => void;
}) {
  const folders = useFolders();
  const detail = useDraft(draft?.id ?? "", { enabled: open && !!draft });
  const promote = usePromoteDraft();
  const { toast } = useToast();
  const titleId = useId();
  const [folderId, setFolderId] = useState("");
  const [tagsText, setTagsText] = useState("");

  // Reset the form whenever a different draft opens the dialog.
  useEffect(() => {
    if (open) {
      setFolderId("");
      setTagsText("");
    }
  }, [open]);

  const folderOptions = [
    { label: "Unfiled", value: "" },
    ...(folders.data ?? []).map((f) => ({ label: f.name, value: f.id })),
  ];

  const onPromote = () => {
    if (!draft) return;
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    promote.mutate(
      { id: draft.id, body: { folderId: folderId || null, tags } },
      {
        onSuccess: () => {
          toast(`Promoted “${draft.name}”`);
          onClose();
        },
        onError: (e) => toast((e as Error).message),
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} width={460} labelledBy={titleId}>
      <ModalHeader
        icon={<Check size={20} />}
        title="Promote draft"
        titleId={titleId}
        subtitle={draft ? draft.name : undefined}
        onClose={onClose}
      />
      <ModalBody>
        {draft && draft.checkpointCount === 0 && (
          <p className={styles.warn}>
            This draft has no checkpoints — it won’t assert anything visually until you add one in
            the editor. You can still promote it.
          </p>
        )}

        {(detail.data?.checkpoints.length ?? 0) > 0 && (
          <div className={styles.previews}>
            <div className={styles.previewsLabel}>
              What this test asserts <span className={styles.hint}>· authoring previews</span>
            </div>
            <div className={styles.previewGrid}>
              {detail.data?.checkpoints.map((c) => (
                <figure key={c.name} className={styles.preview}>
                  {c.previewUrl ? (
                    <img src={c.previewUrl} alt={`${c.name} preview`} loading="lazy" />
                  ) : (
                    <div className={styles.previewMissing}>no preview</div>
                  )}
                  <figcaption title={c.name}>
                    {c.name} <span className={styles.previewMode}>· {c.captureMode}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
            <p className={styles.previewHint}>
              Reference images of what Claude saw — the approved baseline is captured when you first
              run the test.
            </p>
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${titleId}-folder`}>
            Folder
          </label>
          <Select
            id={`${titleId}-folder`}
            options={folderOptions}
            value={folderId}
            onValueChange={setFolderId}
            ariaLabel="Folder"
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${titleId}-tags`}>
            Tags <span className={styles.hint}>· comma-separated</span>
          </label>
          <Input
            id={`${titleId}-tags`}
            value={tagsText}
            placeholder="release:5.0, feature:dashboard"
            onChange={(e) => setTagsText(e.target.value)}
          />
        </div>
        <p className={styles.note}>
          Promoting files this test and makes it runnable in suites. Its baselines still go through
          the normal per-environment approval when you first run it.
        </p>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" loading={promote.isPending} onClick={onPromote}>
          Promote test
        </Button>
      </ModalFooter>
    </Modal>
  );
}
