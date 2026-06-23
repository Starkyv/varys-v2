import { cx } from "@varys/ui";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import styles from "./styles.module.scss";

export interface NotesCardProps {
  /** The saved note, or null when none. */
  notes: string | null;
  /** Persist the (trimmed) note — empty string clears it. Should reject on failure so the
   *  editor stays open and the draft isn't lost (pass a mutation's `mutateAsync`). */
  onSave: (text: string) => Promise<unknown>;
  /** Whether a save is in flight (drives the subtle "Saving…" status). */
  saving?: boolean;
  placeholder?: string;
}

/**
 * A minimalist, inline notes editor shared by the run- and test-detail pages. Quiet by default —
 * a small "Notes" label over the note text (or an "Add a note…" prompt). Click to edit: the
 * textarea matches the text metrics so there's no jump, it auto-grows, and it commits on blur
 * (⌘/Ctrl+Enter to commit, Esc to discard). Clearing the text removes the note.
 */
export function NotesCard({ notes, onSave, saving = false, placeholder }: NotesCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [justSaved, setJustSaved] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  const ph = placeholder ?? "Add a note…";

  // Keep the draft in sync with the saved value while not editing (e.g. after a refetch).
  useEffect(() => {
    if (!editing) setDraft(notes ?? "");
  }, [notes, editing]);

  const resize = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => {
    if (editing) resize(ref.current);
  }, [editing]);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const enterEdit = () => {
    setDraft(notes ?? "");
    setJustSaved(false);
    setEditing(true);
  };

  // Commit on blur (and ⌘↵). Esc sets cancelRef so the ensuing blur discards instead.
  const commit = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setDraft(notes ?? "");
      setEditing(false);
      return;
    }
    const next = draft.trim();
    if (next === (notes ?? "").trim()) {
      setEditing(false);
      return;
    }
    onSave(next).then(
      () => {
        setEditing(false);
        setJustSaved(true);
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setJustSaved(false), 1800);
      },
      () => {
        // Save failed — keep the editor open with the draft intact; the caller toasts.
        setEditing(true);
        ref.current?.focus();
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelRef.current = true;
      e.currentTarget.blur();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  return (
    <section className={cx(styles.root, editing && styles.editing)}>
      <div className={styles.head}>
        <span className={styles.label}>Notes</span>
        <span className={styles.status} aria-live="polite">
          {saving ? "Saving…" : justSaved ? "Saved" : ""}
        </span>
      </div>

      {editing ? (
        <textarea
          ref={ref}
          className={styles.textarea}
          value={draft}
          placeholder={ph}
          rows={1}
          // biome-ignore lint/a11y/noAutofocus: the field is summoned by an explicit click
          autoFocus
          onFocus={(e) => {
            const len = e.currentTarget.value.length;
            e.currentTarget.setSelectionRange(len, len);
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            resize(e.target);
          }}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      ) : notes ? (
        <button type="button" className={styles.display} onClick={enterEdit} aria-label="Edit note">
          {notes}
        </button>
      ) : (
        <button type="button" className={styles.empty} onClick={enterEdit}>
          {ph}
        </button>
      )}
    </section>
  );
}
