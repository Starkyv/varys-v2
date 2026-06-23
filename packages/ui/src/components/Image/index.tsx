import { type ImgHTMLAttributes, type ReactNode, type Ref, useLayoutEffect, useRef, useState } from "react";
import { ImageOff } from "../../icons";
import { cx } from "../../utils/cx";
import { Skeleton } from "../Skeleton";
import styles from "./styles.module.scss";

export interface ImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "onLoad" | "onError" | "src" | "ref"> {
  /** The image URL. `null`/`undefined`/`""` renders the fallback directly. */
  src: string | null | undefined;
  alt: string;
  /** Class for the wrapper element (frame sizing, border, aspect-ratio). */
  className?: string;
  /** Class for the inner `<img>` (object-fit / object-position / dimensions). */
  imgClassName?: string;
  /** Placeholder shown while the image is loading (defaults to a Skeleton that fills the frame). */
  placeholder?: ReactNode;
  /** Rendered when the image fails to load or `src` is empty (defaults to a muted broken-image glyph). */
  fallback?: ReactNode;
  /**
   * Reserve this height for the placeholder while loading. Needed for natural-flow
   * images whose frame would otherwise be 0-tall before the image arrives, so the
   * skeleton has something to fill. Number → px.
   */
  loadingMinHeight?: number | string;
  /** Fired once the image is fully decoded (e.g. to read `naturalWidth`/`naturalHeight`). */
  onReady?: (img: HTMLImageElement) => void;
  /** Forwards the underlying `<img>` (e.g. to measure its rendered box). */
  imgRef?: Ref<HTMLImageElement>;
}

type Status = "loading" | "ready" | "error";

/**
 * Image — a screenshot/photo that never paints half-drawn. The `<img>` is held at
 * `opacity: 0` until it has fully decoded, with a {@link Skeleton} (or custom
 * `placeholder`) shown in its place meanwhile; on load it cross-fades in. A failed or
 * empty `src` shows a muted broken-image `fallback` instead.
 *
 * Use this anywhere a remote image (blob storage, captures, previews) is rendered so
 * users see a clean skeleton → image transition rather than a top-down progressive paint.
 */
export function Image({
  src,
  alt,
  className,
  imgClassName,
  placeholder,
  fallback,
  loadingMinHeight,
  onReady,
  imgRef,
  ...rest
}: ImageProps) {
  const [status, setStatus] = useState<Status>(src ? "loading" : "error");
  const [trackedSrc, setTrackedSrc] = useState(src);
  const ref = useRef<HTMLImageElement | null>(null);

  // Re-arm synchronously when the src changes so a new image never inherits the old
  // one's "ready" opacity (which would let it paint progressively for a frame).
  if (src !== trackedSrc) {
    setTrackedSrc(src);
    setStatus(src ? "loading" : "error");
  }

  // A cached image can already be `complete` before React wires up onLoad — reconcile
  // from the DOM before paint so cached images appear instantly (no skeleton flash).
  // biome-ignore lint/correctness/useExhaustiveDependencies: onReady is a fire-and-forget callback, intentionally excluded.
  useLayoutEffect(() => {
    if (!src) return;
    const img = ref.current;
    if (img?.complete && img.naturalWidth > 0) {
      setStatus("ready");
      onReady?.(img);
    }
  }, [src]);

  const assignRef = (el: HTMLImageElement | null) => {
    ref.current = el;
    if (typeof imgRef === "function") imgRef(el);
    else if (imgRef) (imgRef as { current: HTMLImageElement | null }).current = el;
  };

  const reserve = status === "loading" && loadingMinHeight != null ? { minHeight: loadingMinHeight } : undefined;

  return (
    <span className={cx(styles.wrap, className)} data-status={status} style={reserve}>
      {status === "error" ? (
        (fallback ?? (
          <span className={styles.broken} aria-hidden>
            <ImageOff size={20} />
          </span>
        ))
      ) : (
        <img
          ref={assignRef}
          className={cx(styles.img, status === "ready" && styles.ready, imgClassName)}
          src={src ?? undefined}
          alt={alt}
          draggable={false}
          decoding="async"
          onLoad={(e) => {
            setStatus("ready");
            onReady?.(e.currentTarget);
          }}
          onError={() => setStatus("error")}
          {...rest}
        />
      )}
      {status === "loading" && (placeholder ?? <Skeleton className={styles.ph} radius="0" />)}
    </span>
  );
}
