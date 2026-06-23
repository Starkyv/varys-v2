import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

/** One content block inside an InfoTip popover. Mirrors the "liquid glass" design:
 *  a heading (accent dot + title), an uppercase accent subheading, a paragraph, a
 *  bulleted points list, or a small table. */
export type InfoTipBlock =
  | { type: "heading"; text: string }
  | { type: "subheading"; text: string }
  | { type: "para"; text: string }
  | { type: "points"; items: string[] }
  /** A small table. Cells are `ReactNode`, so any cell can be custom HTML — e.g. a status
   *  chip — not just text. */
  | { type: "table"; head: ReactNode[]; rows: ReactNode[][] }
  /** Arbitrary custom content, rendered as-is — for anything the block types above don't cover. */
  | { type: "custom"; content: ReactNode };

export type InfoTipPlacement = "bottom" | "top" | "left" | "right";

export interface InfoTipProps {
  /** The content to render, top to bottom. */
  blocks: InfoTipBlock[];
  /** Accessible label for the trigger (also its tooltip title). */
  label?: string;
  /** Trigger glyph — an italic serif "i" or a "?". */
  icon?: "i" | "?";
  /** Which side the popover opens on, relative to the trigger. */
  placement?: InfoTipPlacement;
  /** Accent colour for the dot/subheading/trigger; any CSS colour. */
  accent?: string;
  /** Popover width in px. */
  width?: number;
  /** Trigger diameter in px. */
  triggerSize?: number;
  /** Cap the popover height and scroll past it. Omit (default) to size to content with no
   *  scrollbar. */
  maxHeight?: number;
  /**
   * Render the popover in a portal on `document.body`, fixed-positioned to the trigger.
   * Use this when the trigger sits inside a container that clips (`overflow` other than
   * visible) — e.g. a scrollable table — so the popover can't be cut off. Default is the
   * design's in-flow absolute positioning.
   */
  portal?: boolean;
  className?: string;
}

const DEFAULT_ACCENT = "#5347ce";
const GAP = 12;

/** In-flow (absolute) popover offset relative to the trigger, per placement. */
function popPosition(placement: InfoTipPlacement, width: number): CSSProperties {
  switch (placement) {
    case "top":
      return { bottom: `calc(100% + ${GAP}px)`, left: "50%", marginLeft: -width / 2 };
    case "right":
      return { left: `calc(100% + ${GAP}px)`, top: "50%", transform: "translateY(-50%)" };
    case "left":
      return { right: `calc(100% + ${GAP}px)`, top: "50%", transform: "translateY(-50%)" };
    default:
      return { top: `calc(100% + ${GAP}px)`, left: "50%", marginLeft: -width / 2 };
  }
}

/** Portal (fixed) popover coords from the trigger's viewport rect, per placement. Uses
 *  viewport-edge anchors + a centring transform so the popover's own size isn't needed. */
function fixedPosition(placement: InfoTipPlacement, r: DOMRect): CSSProperties {
  switch (placement) {
    case "top":
      return {
        bottom: window.innerHeight - r.top + GAP,
        left: r.left + r.width / 2,
        transform: "translateX(-50%)",
      };
    case "right":
      return { left: r.right + GAP, top: r.top + r.height / 2, transform: "translateY(-50%)" };
    case "left":
      return {
        right: window.innerWidth - r.left + GAP,
        top: r.top + r.height / 2,
        transform: "translateY(-50%)",
      };
    default:
      return { top: r.bottom + GAP, left: r.left + r.width / 2, transform: "translateX(-50%)" };
  }
}

/** Arrow position + the two highlighted edges that sell the glass bevel, per placement.
 *  Relative to the popover, so it's the same in-flow or portaled. */
function arrowPosition(placement: InfoTipPlacement): CSSProperties {
  const hi = "1px solid rgba(255,255,255,.6)";
  const lo = "1px solid rgba(255,255,255,.4)";
  switch (placement) {
    case "top":
      return { bottom: -6, left: "50%", marginLeft: -6, borderRight: lo, borderBottom: lo };
    case "right":
      return { left: -6, top: "50%", marginTop: -6, borderLeft: hi, borderBottom: lo };
    case "left":
      return { right: -6, top: "50%", marginTop: -6, borderRight: hi, borderTop: lo };
    default:
      return {
        top: -6,
        left: "50%",
        marginLeft: -6,
        borderLeft: "1px solid rgba(255,255,255,.7)",
        borderTop: "1px solid rgba(255,255,255,.7)",
      };
  }
}

function Block({ block }: { block: InfoTipBlock }): ReactNode {
  switch (block.type) {
    case "heading":
      return (
        <div className={styles.heading}>
          <span className={styles.headingDot} />
          <div className={styles.headingText}>{block.text}</div>
        </div>
      );
    case "subheading":
      return <div className={styles.subheading}>{block.text}</div>;
    case "para":
      return <p className={styles.para}>{block.text}</p>;
    case "points":
      return (
        <div className={styles.points}>
          {block.items.map((pt, i) => (
            <div key={i} className={styles.point}>
              <span className={styles.pointDot} />
              <span className={styles.pointText}>{pt}</span>
            </div>
          ))}
        </div>
      );
    case "table":
      return (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {block.head.map((h, i) => (
                  <th key={i} className={styles.th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className={styles.td}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "custom":
      return <div className={styles.custom}>{block.content}</div>;
  }
}

/**
 * InfoTip — a frosted-glass ("liquid glass") explainer. A small circular `i`/`?` trigger
 * toggles a popover that renders structured content blocks (heading / subheading / paragraph
 * / points / table). Closes on outside-click or Escape. Drop it next to any label, setting,
 * or inline in a sentence; pass the content via `blocks`.
 *
 * By default the popover is positioned in-flow (absolute) like the source design. Inside a
 * clipping container (a scrollable table, an `overflow: hidden` card), pass `portal` so the
 * popover renders on `document.body` and can't be cut off.
 */
export function InfoTip({
  blocks,
  label = "More info",
  icon = "i",
  placement = "bottom",
  accent = DEFAULT_ACCENT,
  width = 320,
  triggerSize = 22,
  maxHeight,
  portal = false,
  className,
}: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();

  // Close on outside-click / Escape. The portaled popover lives outside the root, so the
  // outside test must exempt it too (else clicking inside it would close immediately).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // In portal mode, track the trigger's viewport rect → fixed coords; follow scroll/resize.
  useEffect(() => {
    if (!open || !portal) return;
    const place = () => {
      const el = rootRef.current;
      if (el) setCoords(fixedPosition(placement, el.getBoundingClientRect()));
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, portal, placement]);

  // Accent drives the icon colour, heading dot, subheading, and point bullets (via the SCSS
  // `--it-accent` custom property), plus a derived soft tint for the trigger's hover bg.
  const rootStyle = { "--it-accent": accent } as CSSProperties;

  const popover = (
    <div
      ref={popRef}
      id={dialogId}
      role="dialog"
      aria-label={label}
      className={styles.pop}
      style={
        portal
          ? { position: "fixed", width, ...(coords ?? { visibility: "hidden" }) }
          : { width, ...popPosition(placement, width) }
      }
    >
      <div className={styles.arrow} style={arrowPosition(placement)} />
      <div
        className={styles.body}
        style={maxHeight != null ? { maxHeight, overflowY: "auto" } : undefined}
      >
        {blocks.map((block, i) => (
          <Block key={i} block={block} />
        ))}
      </div>
    </div>
  );

  return (
    <span ref={rootRef} className={cx(styles.root, className)} style={rootStyle}>
      <button
        type="button"
        className={styles.trigger}
        style={{ width: triggerSize, height: triggerSize }}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <span
          className={styles.icon}
          style={{
            fontFamily: icon === "i" ? 'Georgia, "Times New Roman", serif' : "inherit",
            fontStyle: icon === "i" ? "italic" : "normal",
            fontSize: triggerSize * 0.62,
          }}
        >
          {icon}
        </span>
      </button>

      {open && (portal ? createPortal(popover, document.body) : popover)}
    </span>
  );
}
