import type { CheckpointView, Rect } from "@varys/review-contract";
import { Button, Sliders } from "@varys/ui";
import { useState } from "react";
// The static (no-diff) mask editor — shared with the Test-detail baseline editor.
import { BaselineMaskCanvas } from "../../../TestDetail/components/BaselineMaskCanvas";
import { useToast } from "../../../../context/toast";
import { usePersistMasks } from "../../../../queries";
import styles from "./styles.module.scss";

/**
 * Mask editor for a checkpoint on its FIRST run (pending baseline). There's no prior baseline to
 * diff against yet, so unlike the run-review `MaskTuning` there's no re-evaluate/threshold preview
 * — you just draw / move / resize the regions to ignore, over the capture that's about to become
 * the baseline. Save writes a new test version (via the pending-aware `persistMasks`), so the masks
 * are in place the moment this capture is approved and on every future run. Masks recorded during
 * authoring show up here pre-filled, so you can see and adjust them before approving.
 */
export function PendingMaskEditor({ runId, checkpoint: cp }: { runId: string; checkpoint: CheckpointView }) {
  const { toast } = useToast();
  const persist = usePersistMasks(runId, cp.name);
  const [masks, setMasks] = useState<Rect[]>(cp.masks);

  const dirty = JSON.stringify(masks) !== JSON.stringify(cp.masks);

  if (!cp.actualUrl) return null;

  function save() {
    persist.mutate(
      { masks },
      {
        onSuccess: (r) => toast(`Masks saved → version v${r.version}`),
        onError: (e) => toast(e instanceof Error ? e.message : "Save failed"),
      },
    );
  }

  return (
    <div className={styles.editor}>
      <div className={styles.head}>
        <span className={styles.headIcon}>
          <Sliders size={15} />
        </span>
        <span className={styles.headText}>
          Mask volatile regions before approving this as the baseline. Drag to add a mask; drag a
          mask to move it, or its handles to resize. Masked areas are ignored on every future run —
          anything drawn while recording is pre-filled here.
        </span>
      </div>
      <BaselineMaskCanvas src={cp.actualUrl} masks={masks} onChange={setMasks} />
      <div className={styles.actions}>
        <Button variant="secondary" size="sm" loading={persist.isPending} disabled={!dirty} onClick={save}>
          Save masks
        </Button>
      </div>
    </div>
  );
}
