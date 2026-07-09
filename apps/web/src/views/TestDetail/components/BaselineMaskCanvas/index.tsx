import type { Rect } from "@varys/review-contract";
import {
  Button,
  cx,
  Dash,
  Grip,
  IconButton,
  Pencil,
  Plus,
  SegmentedControl,
  type SegmentedOption,
  Skeleton,
} from "@varys/ui";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import styles from "./styles.module.scss";

/** What a left-drag does: draw a new mask rectangle, or pan the zoomed image. */
type Mode = "draw" | "move";

const MIN_ZOOM = 1; // 1 = fit the canvas to the panel width
const MAX_ZOOM = 6;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

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
 * Draw diff-ignore masks on a static baseline image (Test Detail). A trimmed sibling of the run's
 * MaskTuning: same zoom/pan/draw mechanics and natural-pixel coordinate space, but no diff/threshold
 * /re-evaluate — masks just bubble up via `onChange` to be staged into the test-config patch. Masks
 * are stored in screenshot-pixel space and positioned by percentage, so they track the image at any
 * zoom.
 */
export function BaselineMaskCanvas({
  src,
  masks,
  onChange,
}: {
  src: string;
  masks: Rect[];
  onChange: (masks: Rect[]) => void;
}) {
  const [mode, setMode] = useState<Mode>("draw");
  const [zoom, setZoom] = useState(1);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [imgReady, setImgReady] = useState(false);

  const imgRef = useRef<HTMLImageElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const panStart = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const prevZoom = useRef(1);
  const anchor = useRef<{ x: number; y: number } | null>(null);

  const drawing = mode === "draw";

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

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (drawing) {
      dragStart.current = toNatural(e.clientX, e.clientY);
      setDraft({ ...dragStart.current, width: 0, height: 0 });
    } else {
      const vp = viewportRef.current;
      panStart.current = { x: e.clientX, y: e.clientY, sl: vp?.scrollLeft ?? 0, st: vp?.scrollTop ?? 0 };
    }
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (dragStart.current) {
      setDraft(rectFrom(dragStart.current, toNatural(e.clientX, e.clientY)));
    } else if (panStart.current) {
      const vp = viewportRef.current;
      if (vp) {
        vp.scrollLeft = panStart.current.sl - (e.clientX - panStart.current.x);
        vp.scrollTop = panStart.current.st - (e.clientY - panStart.current.y);
      }
    }
  };
  const onPointerUp = () => {
    const d = draft;
    dragStart.current = null;
    panStart.current = null;
    setDraft(null);
    if (d && d.width >= 4 && d.height >= 4) onChange([...masks, d]);
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

  const modeOptions: SegmentedOption<Mode>[] = [
    { value: "draw", label: "Draw", icon: <Pencil size={14} /> },
    { value: "move", label: "Move", icon: <Grip size={14} /> },
  ];

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <SegmentedControl ariaLabel="Pointer mode" size="sm" options={modeOptions} value={mode} onValueChange={setMode} />
        <span className={styles.count}>
          {masks.length} mask{masks.length === 1 ? "" : "s"}
        </span>
        <Button variant="secondary" size="sm" disabled={masks.length === 0} onClick={() => onChange([])}>
          Clear
        </Button>
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

      <div ref={viewportRef} className={styles.viewport}>
        <div className={styles.canvas} style={{ width: `${zoom * 100}%` }}>
          <img
            ref={imgRef}
            className={cx(styles.img, !imgReady && styles.imgHidden)}
            src={src}
            alt="baseline to mask"
            decoding="async"
            loading="lazy"
            draggable={false}
            onLoad={(e) => {
              setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
              setImgReady(true);
            }}
          />
          {!imgReady && <Skeleton className={styles.shimmer} radius="0" />}
          <div
            className={cx(styles.drawLayer, drawing ? styles.drawCursor : styles.panCursor)}
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
                  onClick={() => onChange(masks.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            {drawing && draft && <div className={styles.draft} style={pct(draft)} />}
          </div>
        </div>
      </div>
    </div>
  );
}
