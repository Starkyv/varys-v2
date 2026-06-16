import { ChevronDown } from "@varys/ui";
import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "../../lib/auth";
import styles from "./styles.module.scss";

/** Two-letter avatar initials from a name ("Ada Lovelace" → "AL") or email. */
function initials(label: string): string {
  const base = label.trim();
  if (!base) return "?";
  const parts = base.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

/** The signed-in identity + sign-out, in the top bar. */
export function UserMenu() {
  const { data } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!data) return null;
  const { user } = data;
  const label = user.name || user.email;

  return (
    <div className={styles.root} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className={styles.avatar}>{initials(label)}</span>
        <span className={styles.name}>{label}</span>
        <ChevronDown size={16} />
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.identity}>
            <div className={styles.menuName}>{user.name || "Signed in"}</div>
            <div className={styles.menuEmail}>{user.email}</div>
          </div>
          <button
            type="button"
            role="menuitem"
            className={styles.signout}
            onClick={() => {
              setOpen(false);
              // The session store clears on success → <SessionGate> shows Login.
              void signOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
