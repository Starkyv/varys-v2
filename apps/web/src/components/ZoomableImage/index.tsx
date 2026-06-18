import { cx, Search, X } from "@varys/ui";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./styles.module.scss";

/**
 * An inline image that opens to a full-screen lightbox on click — for inspecting a
 * screenshot at full size without leaving the page. The overlay renders in a portal on
 * `document.body` (so it escapes any sticky/overflow ancestor), dims the page, and
 * closes on backdrop click, the close button, or Escape. Body scroll is locked while
 * open and focus is restored to the trigger on close.
 */
export function ZoomableImage({
  src,
  alt,
  className,
  imgClassName,
  caption,
  hintLabel,
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
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevActive?.focus?.();
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={cx(styles.trigger, className)}
        onClick={() => setOpen(true)}
        title="Click to view full image"
        aria-label={`View full image: ${alt}`}
      >
        <img className={cx(styles.img, imgClassName)} src={src} alt={alt} draggable={false} />
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
            aria-label={caption ?? alt}
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            {/* biome-ignore lint/a11y/noAutofocus: a lightbox should take focus so Escape/Tab act on it immediately. */}
            <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="Close full image" autoFocus>
              <X size={20} />
            </button>
            <img className={styles.full} src={src} alt={alt} draggable={false} />
            <div className={styles.caption}>{caption ?? alt}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
