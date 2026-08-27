import type { TestConfigAssertion } from "@varys/review-contract";
import { Badge, Card, Check, IconButton, Trash, cx } from "@varys/ui";
import { PinnedAssertion } from "../../../../components/PinnedAssertion";
import styles from "./styles.module.scss";

/**
 * The test's declared Assertions, in the editor (Slice 19, slice 09).
 *
 * Two things are editable here, and deliberately only two: the plain-language `check` (the sentence
 * a reviewer reads) and whether the assertion exists at all. The pinned form is shown but not
 * edited — this slice's pinned forms are hand-written in the definition, and Claude proposing one
 * is a later slice. Showing it read-only is still the point: an author who can't see which elements
 * a check reads has no way to review it.
 *
 * The `id` is never editable. It is the identity the assertion's history hangs off, so renaming it
 * would silently orphan every past verdict — "rename the id" is a delete plus a declare, and has to
 * read as one.
 */
export function AssertionsEditor({
  assertions,
  checks,
  removed,
  onCheckChange,
  onRemove,
  onRestore,
}: {
  assertions: TestConfigAssertion[];
  /** The current (possibly unsaved) check text per assertion id. */
  checks: Record<string, string>;
  /** Ids staged for removal — struck through until the save writes the new version. */
  removed: Set<string>;
  onCheckChange: (id: string, check: string) => void;
  onRemove: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  return (
    <Card>
      <div className={styles.head}>
        <span className={styles.icon}>
          <Check size={15} />
        </span>
        <div className={styles.headText}>
          <div className={styles.title}>Assertions</div>
          <div className={styles.sub}>
            Checks on a relationship — the total against the sum of its rows, a count against a
            badge. Evaluated on every run in the worker, with no model call.
          </div>
        </div>
        {assertions.length > 0 && (
          <span className={styles.count}>
            {assertions.length} declared
          </span>
        )}
      </div>

      {assertions.length === 0 ? (
        <p className={styles.empty}>
          None declared. An assertion is a named check with a stable id, written into the test
          definition — a pixel comparison can’t tell you that a total stopped adding up.
        </p>
      ) : (
        <ul className={styles.list}>
          {assertions.map((a) => {
            const isRemoved = removed.has(a.id);
            return (
              <li key={a.id} className={cx(styles.item, isRemoved && styles.removed)}>
                <div className={styles.itemHead}>
                  <code className={styles.id}>{a.id}</code>
                  {!a.pinned && (
                    <Badge tone="neutral" size="sm">
                      Not pinned
                    </Badge>
                  )}
                  {isRemoved && (
                    <Badge tone="danger" size="sm">
                      Removing
                    </Badge>
                  )}
                  <span className={styles.spacer} />
                  {isRemoved ? (
                    <button type="button" className={styles.restore} onClick={() => onRestore(a.id)}>
                      Keep it
                    </button>
                  ) : (
                    <IconButton
                      variant="ghost"
                      size="sm"
                      icon={<Trash size={14} />}
                      label={`Remove assertion ${a.id}`}
                      onClick={() => onRemove(a.id)}
                    />
                  )}
                </div>

                <textarea
                  className={styles.checkInput}
                  rows={2}
                  aria-label={`Check text for ${a.id}`}
                  disabled={isRemoved}
                  value={checks[a.id] ?? ""}
                  onChange={(e) => onCheckChange(a.id, e.target.value)}
                />
                <p className={styles.help}>
                  Plain language, for whoever reads a failure. Rewording it keeps the assertion’s id
                  — and therefore its whole history.
                </p>

                <div className={styles.pinnedBlock}>
                  <span className={styles.pinnedLabel}>What it compares</span>
                  <PinnedAssertion pinned={a.pinned} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
