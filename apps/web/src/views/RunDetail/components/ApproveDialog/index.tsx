import { AlertTriangle, Button, Modal } from "@varys/ui";
import { useId } from "react";
import { useSession } from "../../../../lib/auth";
import styles from "./styles.module.scss";

/**
 * The irreversible-approve confirmation — the sole guard on the product's only
 * unrecoverable action (replacing a golden baseline). Serves both a single
 * checkpoint (`name`) and the run-level bulk approve (`count`).
 */
export function ApproveDialog({
  open,
  onClose,
  onConfirm,
  name,
  count,
  identical,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  name?: string;
  count?: number;
  /** Single-checkpoint re-baseline of a *passing* capture that already matches the
   *  current golden — surfaces a "nothing visibly changes" note. */
  identical?: boolean;
}) {
  const titleId = useId();
  const isAll = count != null;
  const { data } = useSession();
  return (
    <Modal open={open} onClose={onClose} width={420} labelledBy={titleId}>
      <div className={styles.body}>
        <span className={styles.icon}>
          <AlertTriangle size={22} />
        </span>
        <div>
          <div id={titleId} className={styles.title}>
            {isAll ? "Approve all in run?" : "Replace baseline?"}
          </div>
          <p className={styles.text}>
            {isAll ? (
              <>
                Approving permanently sets or replaces the golden baseline for every one of the{" "}
                <strong>{count}</strong> checkpoints that need review in this run.{" "}
              </>
            ) : (
              <>
                Approving <strong>{name}</strong> permanently replaces the golden baseline for this
                checkpoint &amp; environment.{" "}
              </>
            )}
            <strong className={styles.warn}>This cannot be undone.</strong>
          </p>
          {identical && (
            <p className={styles.text}>
              This capture already matches the current baseline — re-baselining just re-anchors the
              golden to this run.
            </p>
          )}
          {data?.user?.email && (
            <p className={styles.actor}>Approving as {data.user.email} — this is recorded.</p>
          )}
        </div>
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {isAll ? "Approve all" : "Approve & replace"}
        </Button>
      </div>
    </Modal>
  );
}
