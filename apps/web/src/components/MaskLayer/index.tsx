import type { Rect } from "@varys/review-contract";
import { cx } from "@varys/ui";
import { type PointerEvent as ReactPointerEvent, type RefObject, useRef, useState } from "react";
import styles from "./styles.module.scss";

/** The 8 resize handles — corners + edge midpoints. The string names the edges that move. */
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

const MIN = 4; // smallest mask, in natural (screenshot) pixels
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Normalize two corner points into a positive-area rectangle (natural px, rounded). */
function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    width: Math.round(Math.abs(a.x - b.x)),
    height: Math.round(Math.abs(a.y - b.y)),
  };
}

/** Translate a rect by a natural-px delta, clamped so it stays fully inside the image. */
function moveRect(r: Rect, dx: number, dy: number, nat: { w: number; h: number }): Rect {
  return {
    x: Math.round(clamp(r.x + dx, 0, nat.w - r.width)),
    y: Math.round(clamp(r.y + dy, 0, nat.h - r.height)),
    width: r.width,
    height: r.height,
  };
}

/** Resize a rect by dragging `handle` a natural-px delta; clamps to the image and a min size,
 *  and never lets an edge cross its opposite (so the rect can't invert). */
function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, nat: { w: number; h: number }): Rect {
  let left = r.x;
  let top = r.y;
  let right = r.x + r.width;
  let bottom = r.y + r.height;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - MIN);
  if (handle.includes("e")) right = clamp(right + dx, left + MIN, nat.w);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - MIN);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + MIN, nat.h);
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

/** The in-progress gesture; lives in a ref so pointermove/up read the latest without re-render. */
type Gesture =
  | { kind: "draw"; startX: number; startY: number }
  | { kind: "pan"; clientX: number; clientY: number; sl: number; st: number }
  | { kind: "move"; index: number; startX: number; startY: number; orig: Rect }
  | { kind: "resize"; index: number; handle: Handle; startX: number; startY: number; orig: Rect };

/**
 * The interactive mask overlay shared by the Test-detail baseline editor and the Run-review
 * tuning editor. It sits over the (zoomable) image as an absolute layer and owns the four
 * pointer gestures on masks:
 *   • draw   — drag empty space (when `emptyDrag === "draw"`) to add a rectangle
 *   • move   — drag a mask body to reposition it
 *   • resize — drag one of the 8 handles to reshape it
 *   • pan    — drag empty space (when `emptyDrag === "pan"`, or when not editable) to scroll
 *              the zoomed viewport (via `viewportRef`)
 *
 * Masks are stored in natural screenshot-pixel space and positioned by percentage, so they track
 * the image at any zoom; all gesture math is ratio-based off this layer's own box. `onChange`
 * fires ONCE per gesture, on release (never per-frame) — so a consumer that re-evaluates on every
 * change (MaskTuning) isn't spammed while dragging. Set `editable={false}` (e.g. a diff preview)
 * to hide the masks and allow only panning.
 */
export function MaskLayer({
  masks,
  nat,
  viewportRef,
  emptyDrag,
  editable = true,
  onChange,
}: {
  masks: Rect[];
  /** Natural image dimensions; null until the image has loaded (gestures no-op until then). */
  nat: { w: number; h: number } | null;
  /** The scroll container to pan when dragging empty space in "pan" mode. */
  viewportRef: RefObject<HTMLDivElement | null>;
  /** What a left-drag on EMPTY space does. Mask bodies/handles are always move/resize. */
  emptyDrag: "draw" | "pan";
  /** When false, masks + handles are hidden and only panning is possible (e.g. a diff view). */
  editable?: boolean;
  /** Committed once per gesture (add / move / resize / remove) — never mid-drag. */
  onChange: (masks: Rect[]) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  // Live gesture output mirrored into refs so the pointerup handler commits the latest value
  // regardless of React's render timing.
  const draftRef = useRef<Rect | null>(null);
  const editRef = useRef<{ index: number; rect: Rect } | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [edit, setEdit] = useState<{ index: number; rect: Rect } | null>(null);

  const toNatural = (clientX: number, clientY: number) => {
    const el = layerRef.current;
    if (!el || !nat) return { x: 0, y: 0 };
    const box = el.getBoundingClientRect();
    return {
      x: clamp(((clientX - box.left) / box.width) * nat.w, 0, nat.w),
      y: clamp(((clientY - box.top) / box.height) * nat.h, 0, nat.h),
    };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const idxAttr = target.dataset.maskIndex;
    const handle = target.dataset.handle as Handle | undefined;
    e.currentTarget.setPointerCapture?.(e.pointerId);

    if (editable && nat && idxAttr != null && handle) {
      const i = Number(idxAttr);
      const n = toNatural(e.clientX, e.clientY);
      gesture.current = { kind: "resize", index: i, handle, startX: n.x, startY: n.y, orig: masks[i] };
      setEdit({ index: i, rect: masks[i] });
      editRef.current = { index: i, rect: masks[i] };
      return;
    }
    if (editable && nat && idxAttr != null) {
      const i = Number(idxAttr);
      const n = toNatural(e.clientX, e.clientY);
      gesture.current = { kind: "move", index: i, startX: n.x, startY: n.y, orig: masks[i] };
      setEdit({ index: i, rect: masks[i] });
      editRef.current = { index: i, rect: masks[i] };
      return;
    }
    if (editable && nat && emptyDrag === "draw") {
      const n = toNatural(e.clientX, e.clientY);
      const d: Rect = { x: Math.round(n.x), y: Math.round(n.y), width: 0, height: 0 };
      gesture.current = { kind: "draw", startX: n.x, startY: n.y };
      setDraft(d);
      draftRef.current = d;
      return;
    }
    const vp = viewportRef.current;
    gesture.current = { kind: "pan", clientX: e.clientX, clientY: e.clientY, sl: vp?.scrollLeft ?? 0, st: vp?.scrollTop ?? 0 };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      const vp = viewportRef.current;
      if (vp) {
        vp.scrollLeft = g.sl - (e.clientX - g.clientX);
        vp.scrollTop = g.st - (e.clientY - g.clientY);
      }
      return;
    }
    if (!nat) return;
    const n = toNatural(e.clientX, e.clientY);
    if (g.kind === "draw") {
      const d = rectFrom({ x: g.startX, y: g.startY }, n);
      setDraft(d);
      draftRef.current = d;
    } else if (g.kind === "move") {
      const rect = moveRect(g.orig, n.x - g.startX, n.y - g.startY, nat);
      setEdit({ index: g.index, rect });
      editRef.current = { index: g.index, rect };
    } else {
      const rect = resizeRect(g.orig, g.handle, n.x - g.startX, n.y - g.startY, nat);
      setEdit({ index: g.index, rect });
      editRef.current = { index: g.index, rect };
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "draw") {
      const d = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      if (d && d.width >= MIN && d.height >= MIN) onChange([...masks, d]);
    } else if (g.kind === "move" || g.kind === "resize") {
      const ed = editRef.current;
      editRef.current = null;
      setEdit(null);
      const changed =
        ed &&
        (ed.rect.x !== g.orig.x ||
          ed.rect.y !== g.orig.y ||
          ed.rect.width !== g.orig.width ||
          ed.rect.height !== g.orig.height);
      if (ed && changed) onChange(masks.map((m, i) => (i === ed.index ? ed.rect : m)));
    }
  };

  const pct = (r: Rect) =>
    nat
      ? {
          left: `${(r.x / nat.w) * 100}%`,
          top: `${(r.y / nat.h) * 100}%`,
          width: `${(r.width / nat.w) * 100}%`,
          height: `${(r.height / nat.h) * 100}%`,
        }
      : { display: "none" };

  return (
    <div
      ref={layerRef}
      className={cx(styles.drawLayer, editable && emptyDrag === "draw" ? styles.drawCursor : styles.panCursor)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {editable &&
        masks.map((m, i) => {
          const rect = edit?.index === i ? edit.rect : m;
          return (
            <div
              key={`${m.x},${m.y},${m.width},${m.height},${i}`}
              className={styles.mask}
              style={pct(rect)}
              data-mask-index={i}
            >
              {HANDLES.map((h) => (
                <span
                  key={h}
                  className={cx(styles.handle, styles[`handle_${h}`])}
                  data-mask-index={i}
                  data-handle={h}
                />
              ))}
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
          );
        })}
      {draft && <div className={styles.draft} style={pct(draft)} />}
    </div>
  );
}
