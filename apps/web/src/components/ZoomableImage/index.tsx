import { ChevronRight, cx, Image, Search, Spinner, X } from "@varys/ui";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./styles.module.scss";

/** One image in a navigable lightbox gallery. */
export type GalleryImage = { src: string; label: string };

/**
 * An inline image that opens to a full-screen lightbox on click — for inspecting a
 * screenshot at full size without leaving the page. The overlay renders in a portal on
 * `document.body` (so it escapes any sticky/overflow ancestor), dims the page, and
 * closes on backdrop click, the close button, or Escape. Body scroll is locked while
 * open and focus is restored to the trigger on close.
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

  const items: GalleryImage[] = gallery && gallery.length > 0 ? gallery : [{ src, label: caption ?? alt }];
  const startIndex = Math.max(
    0,
    items.findIndex((g) => g.src === src),
  );
  const current = items[index] ?? items[0];
  const canNavigate = items.length > 1;

  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowRight" && items.length > 1) setIndex((i) => (i + 1) % items.length);
      else if (e.key === "ArrowLeft" && items.length > 1) setIndex((i) => (i - 1 + items.length) % items.length);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevActive?.focus?.();
    };
  }, [open, items.length]);

  return (
    <>
      <button
        type="button"
        className={cx(styles.trigger, className)}
        onClick={() => {
          setIndex(startIndex);
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
              <Image
                className={styles.fullFrame}
                imgClassName={styles.full}
                src={current.src}
                alt={current.label}
                loadingMinHeight={160}
                placeholder={<Spinner size={32} className={styles.fullSpin} />}
              />
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
            <div className={styles.caption}>{current.label}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
