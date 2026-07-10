import type { CheckpointView, Rect } from "@varys/review-contract";
import {
  Button,
  Camera,
  cx,
  Dash,
  Grip,
  IconButton,
  Layers,
  Pencil,
  Plus,
  SegmentedControl,
  type SegmentedOption,
  Skeleton,
  Sliders,
} from "@varys/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MaskLayer } from "../../../../components/MaskLayer";
import { useToast } from "../../../../context/toast";
import { scorePct } from "../../../../lib/format";
import { usePersistMasks, useReEvaluate } from "../../../../queries";
import styles from "./styles.module.scss";

/** Which image fills the canvas: the capture you draw masks on, or the recomputed diff. */
type View = "capture" | "diff";
/** What a left-drag on EMPTY space does: draw a new mask, or pan the zoomed image. Existing
 *  masks are always move/resize (see `MaskLayer`). */
type Mode = "draw" | "move";

const MIN_ZOOM = 1; // 1 = fit the canvas to the panel width
const MAX_ZOOM = 6;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * The in-viewer tuning surface (the HITL slice). One zoomable canvas: draw / move / resize mask
 * rectangles over the captured image to suppress volatile regions and nudge the per-checkpoint
 * threshold; every change re-diffs the STORED baseline+actual server-side (no re-run) and previews
 * the new verdict live. Flip the canvas to "Masked diff" to inspect the recomputed result at the
 * same zoom. Save persists masks + threshold as a new test version and re-judges the checkpoint.
 *
 * Zoom is a multiplier on fit-to-width (1 = fits the panel), realized as the canvas width so the
 * viewport scrolls past 100%. Masks are stored in screenshot-pixel (natural) space and positioned
 * with percentages (in the shared `MaskLayer`), so they track the image at any zoom; the draw math
 * is ratio-based and stays pixel-accurate regardless of the displayed size.
 */
export function MaskTuning({ checkpoint: cp, runId }: { checkpoint: CheckpointView; runId: string }) {
  const { toast } = useToast();
  const [masks, setMasks] = useState<Rect[]>(cp.masks);
  const [threshold, setThreshold] = useState(cp.threshold);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [imgReady, setImgReady] = useState(false);
  const [view, setView] = useState<View>("capture");
  const [mode, setMode] = useState<Mode>("draw");
  const [zoom, setZoom] = useState(1);

  const imgRef = useRef<HTMLImageElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Zoom anchoring: the screen point to keep fixed while scaling (cursor for wheel, centre for buttons).
  const prevZoom = useRef(1);
  const anchor = useRef<{ x: number; y: number } | null>(null);

  const reEval = useReEvaluate(runId, cp.name);
  const persist = usePersistMasks(runId, cp.name);
  const result = reEval.data;

  // The diff to show: the freshly re-evaluated one if present, else the run's stored diff.
  const diffSrc = result?.diffImage ?? cp.diffUrl ?? null;

  const reevaluate = (m: Rect[], t: number) => reEval.mutate({ masks: m, threshold: t });
  const applyMasks = (next: Rect[]) => {
    setMasks(next);
    reevaluate(next, threshold);
  };
  const changeThreshold = (t: number) => {
    setThreshold(t);
    reevaluate(masks, t);
  };

  // Keep the anchor point under the cursor/centre fixed as the canvas rescales.
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    const ratio = zoom / prevZoom.current;
    if (vp && ratio !== 1 && anchor.current) {
      const rect = vp.getBoundingClientRect();
      const ax = anchor.current.x - rect.left;
      const ay = anchor.current.y - rect.top;
      vp.scrollLeft = (vp.scrollLeft + ax) * ratio - ax;
      vp.scrollTop = (vp.scrollTop + ay) * ratio - ay;
    }
    prevZoom.current = zoom;
    anchor.current = null;
  }, [zoom]);

  // ⌘/Ctrl + wheel zooms toward the cursor. Native (non-passive) so we can preventDefault.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      anchor.current = { x: e.clientX, y: e.clientY };
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const vp = viewportRef.current;
    if (vp) {
      const r = vp.getBoundingClientRect();
      anchor.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    setZoom((z) => clampZoom(z * factor));
  };
  const fit = () => {
    anchor.current = null;
    setZoom(MIN_ZOOM);
    const vp = viewportRef.current;
    if (vp) {
      vp.scrollLeft = 0;
      vp.scrollTop = 0;
    }
  };

  function save() {
    persist.mutate(
      { masks, threshold },
      {
        onSuccess: (r) => toast(`Masks & threshold saved → version v${r.version}`),
        onError: (e) => toast(e instanceof Error ? e.message : "Save failed"),
      },
    );
  }

  const viewOptions: SegmentedOption<View>[] = [
    { value: "capture", label: "Capture", icon: <Camera size={14} /> },
    { value: "diff", label: "Masked diff", icon: <Layers size={14} /> },
  ];
  const modeOptions: SegmentedOption<Mode>[] = [
    { value: "draw", label: "Draw", icon: <Pencil size={14} /> },
    { value: "move", label: "Pan", icon: <Grip size={14} /> },
  ];

  return (
    <div className={styles.tuning}>
      <div className={styles.head}>
        <span className={styles.headIcon}>
          <Sliders size={15} />
        </span>
        <span className={styles.headText}>
          Zoom in and drag on the capture to mask a volatile region; drag a mask to move it or its
          handles to resize. Adjust the threshold for sensitivity. Masked areas are ignored by the
          diff — switch to “Masked diff” to preview the recomputed result.
        </span>
      </div>

      {/* Toolbar: what you're looking at · how an empty drag behaves · zoom */}
      <div className={styles.toolbar}>
        <SegmentedControl ariaLabel="Canvas view" size="sm" options={viewOptions} value={view} onValueChange={setView} />
        {view === "capture" && (
          <SegmentedControl ariaLabel="Pointer mode" size="sm" options={modeOptions} value={mode} onValueChange={setMode} />
        )}
        <span className={styles.spacer} />
        <div className={styles.zoomGroup}>
          <IconButton
            variant="ghost"
            size="sm"
            icon={<Dash size={15} />}
            label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => zoomBy(1 / 1.5)}
          />
          <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <IconButton
            variant="ghost"
            size="sm"
            icon={<Plus size={15} />}
            label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomBy(1.5)}
          />
          <button type="button" className={styles.fitBtn} onClick={fit} disabled={zoom === MIN_ZOOM}>
            Fit
          </button>
        </div>
      </div>

      {/* Canvas — zoomable + scrollable; the shared MaskLayer handles draw / move / resize / pan */}
      <div ref={viewportRef} className={styles.viewport}>
        <div className={styles.canvas} style={{ width: `${zoom * 100}%` }}>
          {view === "capture"
            ? cp.actualUrl && (
                <img
                  ref={imgRef}
                  className={cx(styles.img, !imgReady && styles.imgHidden)}
                  src={cp.actualUrl}
                  alt="capture to mask"
                  decoding="async"
                  draggable={false}
                  onLoad={(e) => {
                    setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
                    setImgReady(true);
                  }}
                />
              )
            : diffSrc && (
                <img className={styles.img} src={diffSrc} alt="masked diff preview" decoding="async" draggable={false} />
              )}
          {view === "capture" && cp.actualUrl && !imgReady && <Skeleton className={styles.shimmer} radius="0" />}

          <MaskLayer
            masks={masks}
            nat={nat}
            viewportRef={viewportRef}
            emptyDrag={view === "capture" && mode === "draw" ? "draw" : "pan"}
            editable={view === "capture"}
            onChange={applyMasks}
          />
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
    </div>
  );
}
