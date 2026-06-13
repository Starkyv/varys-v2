import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "../../icons";
import { cx } from "../../utils/cx";
import styles from "./styles.module.scss";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  selectSize?: "sm" | "md";
  invalid?: boolean;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
}

interface MenuPos {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

const OPTION_H = 36;
const MENU_MAX = 288;

/**
 * Select — a themed dropdown (custom listbox, not a native `<select>`, so the open
 * menu is fully styled). Keyboard accessible: open with ↑/↓/Enter, navigate with
 * arrows/Home/End, type-ahead to jump, Esc to close. The menu renders in a portal
 * and is positioned against the trigger, so it never clips inside a modal or a
 * scrollable panel.
 */
export function Select({
  options,
  value,
  onValueChange,
  placeholder = "Select…",
  selectSize = "md",
  invalid,
  disabled,
  id,
  ariaLabel,
  className,
}: SelectProps) {
  const reactId = useId();
  const listId = `${reactId}-list`;
  const optionId = (i: number) => `${reactId}-opt-${i}`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef<{ str: string; timer?: ReturnType<typeof setTimeout> }>({ str: "" });

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [highlight, setHighlight] = useState(0);

  const selected = options.find((o) => o.value === value) ?? null;

  const compute = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const desired = Math.min(MENU_MAX, options.length * OPTION_H + 8);
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < desired && r.top > spaceBelow;
    setPos({
      left: r.left,
      width: r.width,
      top: openUp ? undefined : r.bottom + 4,
      bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
      maxHeight: Math.min(MENU_MAX, (openUp ? r.top : spaceBelow) - 8),
    });
  }, [options.length]);

  // Position before paint, then keep attached on scroll/resize while open.
  useLayoutEffect(() => {
    if (open) compute();
  }, [open, compute]);

  useEffect(() => {
    if (!open) return;
    const onScrollResize = () => compute();
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, compute]);

  // Keep the highlighted option scrolled into view.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(highlight))}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, highlight]);

  function openMenu() {
    if (disabled) return;
    const idx = options.findIndex((o) => o.value === value);
    setHighlight(idx >= 0 ? idx : 0);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function pick(opt: SelectOption) {
    if (opt.disabled) return;
    onValueChange(opt.value);
    close();
  }

  function step(dir: 1 | -1) {
    setHighlight((cur) => {
      let i = cur;
      for (let n = 0; n < options.length; n++) {
        i = (i + dir + options.length) % options.length;
        if (!options[i]?.disabled) return i;
      }
      return cur;
    });
  }

  function onTypeahead(key: string) {
    const ta = typeahead.current;
    clearTimeout(ta.timer);
    ta.str += key.toLowerCase();
    ta.timer = setTimeout(() => {
      ta.str = "";
    }, 600);
    const match = options.findIndex((o) => o.label.toLowerCase().startsWith(ta.str));
    if (match >= 0) setHighlight(match);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        step(-1);
        break;
      case "Home":
        e.preventDefault();
        setHighlight(options.findIndex((o) => !o.disabled));
        break;
      case "End":
        e.preventDefault();
        for (let i = options.length - 1; i >= 0; i--) {
          if (!options[i].disabled) {
            setHighlight(i);
            break;
          }
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (options[highlight]) pick(options[highlight]);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation(); // close only the menu, not an enclosing Modal
        close();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (e.key.length === 1) onTypeahead(e.key);
    }
  }

  const menuStyle: CSSProperties = pos
    ? {
        position: "fixed",
        left: pos.left,
        width: pos.width,
        top: pos.top,
        bottom: pos.bottom,
        maxHeight: pos.maxHeight,
      }
    : { display: "none" };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(highlight) : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cx(styles.trigger, styles[selectSize], invalid && styles.invalid, open && styles.open, className)}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className={cx(styles.value, !selected && styles.placeholder)}>{selected?.label ?? placeholder}</span>
        <span className={cx(styles.chevron, open && styles.chevronOpen)}>
          <ChevronDown size={16} />
        </span>
      </button>

      {open &&
        createPortal(
          <div ref={menuRef} id={listId} role="listbox" className={styles.menu} style={menuStyle}>
            {options.map((opt, i) => (
              <div
                key={opt.value}
                id={optionId(i)}
                role="option"
                aria-selected={opt.value === value}
                aria-disabled={opt.disabled || undefined}
                className={cx(
                  styles.option,
                  i === highlight && styles.highlighted,
                  opt.value === value && styles.selected,
                  opt.disabled && styles.optionDisabled,
                )}
                onMouseEnter={() => !opt.disabled && setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(opt);
                }}
              >
                <span className={styles.optionLabel}>{opt.label}</span>
                {opt.value === value && (
                  <span className={styles.check}>
                    <Check size={15} />
                  </span>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
