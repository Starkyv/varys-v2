import { Button, cx } from "@varys/ui";
import styles from "./styles.module.scss";

export function TagFilter({
  tags,
  activeTag,
  onToggle,
  onClear,
  canClear,
}: {
  tags: string[];
  activeTag: string | null;
  onToggle: (tag: string) => void;
  onClear: () => void;
  canClear: boolean;
}) {
  return (
    <div className={styles.bar}>
      <span className={styles.label}>Tags</span>
      {tags.map((t) => (
        <button
          key={t}
          type="button"
          className={cx(styles.chip, activeTag === t && styles.chipActive)}
          onClick={() => onToggle(t)}
        >
          {t}
        </button>
      ))}
      {tags.length === 0 && <span className={styles.none}>No tags yet</span>}
      <span className={styles.spacer} />
      <Button variant="secondary" size="sm" onClick={onClear} disabled={!canClear}>
        Clear filters
      </Button>
    </div>
  );
}
