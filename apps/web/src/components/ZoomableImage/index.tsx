import { ChevronRight, cx, Dash, Image, Plus, Search, Spinner, X } from "@varys/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./styles.module.scss";

/** One image in a navigable lightbox gallery. */
export type GalleryImage = { src: string; label: string };

/** Zoom bounds. 1 = "fit the lightbox"; the top end is what makes a tall notebook
 *  screenshot — scaled down to 86vh to fit — readable again. */
const MIN_SCALE = 1;
const MAX_SCALE = 8;
const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * An inline image that opens to a full-screen lightbox on click — for inspecting a
 * screenshot at full size without leaving the page. The overlay renders in a portal on
 * `document.body` (so it escapes any sticky/overflow ancestor), dims the page, and
 * closes on backdrop click, the close button, or Escape. Body scroll is locked while
 * open and focus is restored to the trigger on close.
 *
 * The lightbox zooms: the wheel zooms toward the pointer, drag pans, double-click toggles
 * 1×↔3×, and the toolbar (or `+` / `-` / `0`) steps and resets it. A checkpoint of a long
 * page arrives scaled to fit the window, where a chart's axis labels are a few pixels tall;
 * without zoom the lightbox can show you that a diff exists but never what it says.
 *
 * Pass `gallery` to make the lightbox traversable: ←/→ (or the on-screen chevrons) step
 * through the ordered list, starting at this image's entry, and a label pill in the
 * top-left names the current image. Without it, the lightbox shows just this `src`.
 */
export function ZoomableImage({
  src,
  alt,
  className,
  imgClassName,
  caption,
  hintLabel,
  gallery,
}: {
  src: string;
  alt: string;
  /** Class for the in-flow trigger button — e.g. to make it fill an aspect-ratio frame. */
  className?: string;
  /** Class for the in-flow image — keeps the host frame's sizing. */
  imgClassName?: string;
  /** Label shown beneath the full image; defaults to `alt`. */
  caption?: string;
  /** Optional text shown next to the zoom icon on hover (e.g. "Click to zoom"). */
  hintLabel?: string;
  /** Ordered images to traverse with arrow keys in the lightbox; opening starts at this `src`. */
  gallery?: GalleryImage[];
}) {
  const [open, setOpen] = useState(false);
  // Index into the gallery while the lightbox is open. Set on open from this `src`.
  const [index, setIndex] = useState(0);
  // Zoom transform: `scale` about the stage centre, `tx`/`ty` in stage pixels (applied
  // BEFORE the scale, so panning feels the same at every zoom level).
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Pointer id + where the drag started, in the same space as `tx`/`ty`. Null = not panning.
  const drag = useRef<{ id: number; x: number; y: number; tx: number; ty: number } | null>(null);

  const items: GalleryImage[] = gallery && gallery.length > 0 ? gallery : [{ src, label: caption ?? alt }];
  const startIndex = Math.max(
    0,
    items.findIndex((g) => g.src === src),
  );
  const current = items[index] ?? items[0];
  const canNavigate = items.length > 1;
  const zoomed = view.scale > 1;

  const resetView = useCallback(() => setView({ scale: 1, tx: 0, ty: 0 }), []);

  /**
   * Zoom to `next`, keeping the point under (`cx`,`cy`) — viewport coordinates — pinned. Without
   * that anchoring, zooming in on a detail walks it off the screen and you pan it back by hand.
   * Omit the point to zoom about the centre (the toolbar and keyboard paths).
   */
  const zoomTo = useCallback((next: number, cx?: number, cy?: number) => {
    setView((v) => {
      const scale = clampScale(next);
      if (scale === v.scale) return v;
      if (scale === 1) return { scale: 1, tx: 0, ty: 0 };
      const box = viewportRef.current?.getBoundingClientRect();
      // Offset of the anchor from the stage centre, which is what the transform scales about.
      // Keeping the content point under the anchor fixed means `a = t + s·p` before and after:
      //   t₂ = a − s₂·p  where  p = (a − t₁)/s₁.
      const ax = box && cx !== undefined ? cx - (box.left + box.width / 2) : 0;
      const ay = box && cy !== undefined ? cy - (box.top + box.height / 2) : 0;
      const k = scale / v.scale;
      return { scale, tx: ax - (ax - v.tx) * k, ty: ay - (ay - v.ty) * k };
    });
  }, []);

  // A fresh fit whenever the lightbox opens or steps to another image — a zoom into image 1
  // means nothing on image 2, and arriving pre-panned into a corner reads as a broken shot.
  useEffect(() => {
    resetView();
  }, [index, open, resetView]);

  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowRight" && items.length > 1) setIndex((i) => (i + 1) % items.length);
      else if (e.key === "ArrowLeft" && items.length > 1) setIndex((i) => (i - 1 + items.length) % items.length);
      else if (e.key === "+" || e.key === "=") setView((v) => ({ ...v, scale: clampScale(v.scale * 1.4) }));
      else if (e.key === "-" || e.key === "_") setView((v) => (v.scale / 1.4 <= 1 ? { scale: 1, tx: 0, ty: 0 } : { ...v, scale: v.scale / 1.4 }));
      else if (e.key === "0") resetView();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevActive?.focus?.();
    };
  }, [open, items.length, resetView]);

  // Wheel-to-zoom, bound natively so it can be non-passive (React's onWheel is passive and
  // cannot preventDefault, which would let the wheel scroll the backdrop instead).
  useEffect(() => {
    const el = viewportRef.current;
    if (!open || !el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Trackpad pinch arrives as ctrlKey+wheel; both paths mean the same thing here.
      const factor = Math.exp(-e.deltaY / 300);
      setView((v) => {
        const scale = clampScale(v.scale * factor);
        if (scale === v.scale) return v;
        if (scale === 1) return { scale: 1, tx: 0, ty: 0 };
        const box = el.getBoundingClientRect();
        const ax = e.clientX - (box.left + box.width / 2);
        const ay = e.clientY - (box.top + box.height / 2);
        const k = scale / v.scale;
        return { scale, tx: ax - (ax - v.tx) * k, ty: ay - (ay - v.ty) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={cx(styles.trigger, className)}
        onClick={() => {
          setIndex(startIndex);
          resetView();
          setOpen(true);
        }}
        title="Click to view full image"
        aria-label={`View full image: ${alt}`}
      >
        <Image className={styles.frame} imgClassName={cx(styles.img, imgClassName)} src={src} alt={alt} loadingMinHeight={220} />
        <span className={cx(styles.hint, hintLabel && styles.hintLabeled)} aria-hidden>
          <Search size={14} />
          {hintLabel}
        </span>
      </button>

      {open &&
        createPortal(
          // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a convenience; Escape and the close button are the keyboard paths.
          <div
            className={styles.backdrop}
            role="dialog"
            aria-modal="true"
            aria-label={current.label}
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            {/* biome-ignore lint/a11y/noAutofocus: a lightbox should take focus so Escape/arrows act on it immediately. */}
            <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="Close full image" autoFocus>
              <X size={20} />
            </button>

            <div className={styles.stage} onClick={(e) => e.stopPropagation()}>
              <span className={styles.tag}>
                {current.label}
                {canNavigate && (
                  <span className={styles.tagCount}>
                    {index + 1}/{items.length}
                  </span>
                )}
              </span>
              {canNavigate && (
                <button
                  type="button"
                  className={cx(styles.nav, styles.navPrev)}
                  onClick={() => setIndex((i) => (i - 1 + items.length) % items.length)}
                  aria-label="Previous image"
                >
                  <ChevronRight size={22} />
                </button>
              )}
              {/* Clips the zoomed image to the stage, and owns the pan/zoom gestures. */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: the zoom controls below are the keyboard path; this is pointer sugar. */}
              <div
                ref={viewportRef}
                className={cx(styles.viewport, zoomed && styles.viewportZoomed)}
                onPointerDown={(e) => {
                  if (!zoomed || e.button !== 0) return;
                  drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d || d.id !== e.pointerId) return;
                  setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
                }}
                onPointerUp={(e) => {
                  if (drag.current?.id === e.pointerId) drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onDoubleClick={(e) => (zoomed ? resetView() : zoomTo(3, e.clientX, e.clientY))}
              >
                <div
                  className={styles.pane}
                  style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})` }}
                >
                  <Image
                    className={styles.fullFrame}
                    imgClassName={styles.full}
                    src={current.src}
                    alt={current.label}
                    loadingMinHeight={160}
                    placeholder={<Spinner size={32} className={styles.fullSpin} />}
                  />
                </div>
              </div>
              {canNavigate && (
                <button
                  type="button"
                  className={cx(styles.nav, styles.navNext)}
                  onClick={() => setIndex((i) => (i + 1) % items.length)}
                  aria-label="Next image"
                >
                  <ChevronRight size={22} />
                </button>
              )}
            </div>

            {/* biome-ignore lint/a11y/noStaticElementInteractions: stops a control click from closing the lightbox. */}
            <div className={styles.tools} onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={styles.tool}
                onClick={() => zoomTo(view.scale / 1.4)}
                disabled={view.scale <= MIN_SCALE}
                aria-label="Zoom out"
              >
                <Dash size={16} />
              </button>
              <span className={styles.zoomLevel}>{Math.round(view.scale * 100)}%</span>
              <button
                type="button"
                className={styles.tool}
                onClick={() => zoomTo(view.scale * 1.4)}
                disabled={view.scale >= MAX_SCALE}
                aria-label="Zoom in"
              >
                <Plus size={16} />
              </button>
              <button type="button" className={cx(styles.tool, styles.toolText)} onClick={resetView} disabled={!zoomed}>
                Fit
              </button>
            </div>

            <div className={styles.caption}>{current.label}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
