import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "../../icons";
import { IconButton } from "../IconButton";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number | string;
  /** id of the title element, for `aria-labelledby`. */
  labelledBy?: string;
  className?: string;
}

/**
 * Modal — an accessible centered dialog rendered through a portal. Handles the
 * backdrop, Escape-to-close, click-outside, body scroll-lock and focus, and
 * animates in/out with CSS (so it needs no animation library). Compose the inside
 * with `ModalHeader` / `ModalBody` / `ModalFooter`.
 */
export function Modal({ open, onClose, children, width = 440, labelledBy, className }: ModalProps) {
  const [render, setRender] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setRender(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!render) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, [render]);

  if (!render) return null;

  return createPortal(
    <div
      className={cx(styles.backdrop, open ? styles.backdropIn : styles.backdropOut)}
      onMouseDown={onClose}
      onAnimationEnd={() => {
        if (!open) setRender(false);
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cx(styles.panel, open ? styles.panelIn : styles.panelOut, className)}
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface ModalHeaderProps {
  icon?: ReactNode;
  title: ReactNode;
  titleId?: string;
  subtitle?: ReactNode;
  onClose?: () => void;
}

export function ModalHeader({ icon, title, titleId, subtitle, onClose }: ModalHeaderProps) {
  return (
    <div className={styles.header}>
      {icon && <span className={styles.headerIcon}>{icon}</span>}
      <div className={styles.headerText}>
        <div id={titleId} className={styles.headerTitle}>
          {title}
        </div>
        {subtitle && <div className={styles.headerSubtitle}>{subtitle}</div>}
      </div>
      {onClose && <IconButton variant="ghost" size="sm" icon={<X />} label="Close" onClick={onClose} />}
    </div>
  );
}

export function ModalBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.body, className)}>{children}</div>;
}

export function ModalFooter({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
  return (
    <div className={styles.footer}>
      {leading && <div className={styles.footerLeading}>{leading}</div>}
      <div className={styles.footerActions}>{children}</div>
    </div>
  );
}
