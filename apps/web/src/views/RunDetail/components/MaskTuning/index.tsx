import type { CheckpointView, Rect } from "@varys/review-contract";
import { Button, cx, Skeleton, Sliders } from "@varys/ui";
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { ZoomableImage } from "../../../../components/ZoomableImage";
import { useToast } from "../../../../context/toast";
import { scorePct } from "../../../../lib/format";
import { usePersistMasks, useReEvaluate } from "../../../../queries";
import styles from "./styles.module.scss";

/** Normalize two corner points into a positive-area rectangle. */
function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    width: Math.round(Math.abs(a.x - b.x)),
    height: Math.round(Math.abs(a.y - b.y)),
  };
}

/**
 * The in-viewer tuning surface (the HITL slice). Draw mask rectangles over the
 * captured image to suppress volatile regions and nudge the per-checkpoint
 * threshold; every change re-diffs the STORED baseline+actual server-side (no
 * re-run) and previews the new verdict live. Save persists masks + threshold as a
 * new test version and re-judges the checkpoint.
 *
 * Masks are stored in screenshot-pixel (natural) space; drawn in displayed space
 * and converted via the image's natural/displayed ratio, then positioned with
 * percentages so they track the responsively-scaled image.
 */
export function MaskTuning({ checkpoint: cp, runId }: { checkpoint: CheckpointView; runId: string }) {
  const { toast } = useToast();
  const [masks, setMasks] = useState<Rect[]>(cp.masks);
  const [threshold, setThreshold] = useState(cp.threshold);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [imgReady, setImgReady] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const reEval = useReEvaluate(runId, cp.name);
  const persist = usePersistMasks(runId, cp.name);

  const toNatural = (clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const box = img.getBoundingClientRect();
    const sx = img.naturalWidth / box.width;
    const sy = img.naturalHeight / box.height;
    return {
      x: Math.max(0, Math.min(img.naturalWidth, (clientX - box.left) * sx)),
      y: Math.max(0, Math.min(img.naturalHeight, (clientY - box.top) * sy)),
    };
  };

  const reevaluate = (m: Rect[], t: number) => reEval.mutate({ masks: m, threshold: t });
  const applyMasks = (next: Rect[]) => {
    setMasks(next);
    reevaluate(next, threshold);
  };
  const changeThreshold = (t: number) => {
    setThreshold(t);
    reevaluate(masks, t);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    dragStart.current = toNatural(e.clientX, e.clientY);
    setDraft({ ...dragStart.current, width: 0, height: 0 });
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!dragStart.current) return;
    setDraft(rectFrom(dragStart.current, toNatural(e.clientX, e.clientY)));
  };
  const onPointerUp = () => {
    const d = draft;
    dragStart.current = null;
    setDraft(null);
    if (d && d.width >= 4 && d.height >= 4) applyMasks([...masks, d]);
  };

  const pct = (r: Rect): CSSProperties =>
    nat
      ? {
          left: `${(r.x / nat.w) * 100}%`,
          top: `${(r.y / nat.h) * 100}%`,
          width: `${(r.width / nat.w) * 100}%`,
          height: `${(r.height / nat.h) * 100}%`,
        }
      : { display: "none" };

  const result = reEval.data;

  function save() {
    persist.mutate(
      { masks, threshold },
      {
        onSuccess: (r) => toast(`Masks & threshold saved → version v${r.version}`),
        onError: (e) => toast(e instanceof Error ? e.message : "Save failed"),
      },
    );
  }

  return (
    <div className={styles.tuning}>
      <div className={styles.head}>
        <span className={styles.headIcon}>
          <Sliders size={15} />
        </span>
        <span className={styles.headText}>
          Drag on the capture to mask a volatile region; adjust the threshold for sensitivity. Masked areas are ignored
          by the diff and previewed instantly.
        </span>
      </div>

      <div className={styles.stage}>
        {cp.actualUrl && (
          <img
            ref={imgRef}
            className={cx(styles.img, imgReady && styles.imgReady)}
            src={cp.actualUrl}
            alt="capture to mask"
            decoding="async"
            draggable={false}
            onLoad={(e) => {
              setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
              setImgReady(true);
            }}
          />
        )}
        {cp.actualUrl && !imgReady && <Skeleton className={styles.shimmer} radius="0" />}
        <div
          className={styles.drawLayer}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {masks.map((m, i) => (
            <div key={`${m.x},${m.y},${m.width},${m.height},${i}`} className={styles.mask} style={pct(m)}>
              <button
                type="button"
                className={styles.maskRemove}
                title="Remove mask"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => applyMasks(masks.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          {draft && <div className={styles.draft} style={pct(draft)} />}
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.controlBlock}>
          <div className={styles.controlLabel}>
            <span>Masks</span>
            <span className={styles.muted}>
              {masks.length} ignored region{masks.length === 1 ? "" : "s"}
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => applyMasks([])} disabled={masks.length === 0}>
            Clear masks
          </Button>
        </div>
        <div className={styles.controlBlock}>
          <div className={styles.controlLabel}>
            <span>Threshold</span>
            <span className={styles.mono}>{scorePct(threshold, 2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={0.1}
            step={0.001}
            value={threshold}
            onChange={(e) => changeThreshold(Number(e.target.value))}
            className={styles.slider}
          />
        </div>
      </div>

      <div className={styles.previewRow}>
        <div className={styles.previewText}>
          {reEval.isPending ? (
            <span className={styles.muted}>Re-evaluating…</span>
          ) : result ? (
            <span className={result.verdict === "match" ? styles.match : styles.diff}>
              Preview: <strong>{result.verdict === "match" ? "within threshold" : "still differs"}</strong> · score{" "}
              <span className={styles.mono}>{scorePct(result.diffScore)}</span>
            </span>
          ) : (
            <span className={styles.muted}>Draw a mask or move the threshold to preview.</span>
          )}
          {reEval.isError && <span className={styles.diff}>{(reEval.error as Error).message}</span>}
        </div>
        <Button variant="secondary" size="sm" loading={persist.isPending} onClick={save}>
          Save tuning
        </Button>
      </div>

      {result?.diffImage && (
        <div className={styles.previewImage}>
          <ZoomableImage src={result.diffImage} alt="masked diff preview" imgClassName={styles.img} caption="Masked diff preview" />
        </div>
      )}
    </div>
  );
}
