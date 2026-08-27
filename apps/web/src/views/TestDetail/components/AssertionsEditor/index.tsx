import type { TestConfigAssertion } from "@varys/review-contract";
import { Badge, Card, Check, IconButton, Trash, cx } from "@varys/ui";
import { MODE_META, PinnedAssertion } from "../../../../components/PinnedAssertion";
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
 * Every assertion also declares whether it is EXACT or APPROXIMATE (Slice 19, slice 11). That
 * badge is the whole author-facing half of the judge fallback: a check with no pinned form still
 * runs — a model reads the page and answers it — but it is a reading, not arithmetic, and an
 * author who cannot tell the two apart is one who finds out months later that "the totals are
 * right" was never really being verified. An approximate one carries the vocabulary that would
 * make it exact, so the badge is a route to a fix rather than a shrug.
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
            badge. A pinned check is evaluated on every run in the worker, with no model call; one
            that can’t be pinned is judged instead, approximately.
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
                  <Badge tone={MODE_META[a.mode].tone} size="sm">
                    {MODE_META[a.mode].label}
                  </Badge>
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
                  <span className={styles.pinnedLabel}>
                    {a.mode === "pinned" ? "What it compares" : "How this one is checked"}
                  </span>
                  <p className={styles.modeBlurb}>{MODE_META[a.mode].blurb}</p>
                  <PinnedAssertion pinned={a.pinned} />
                  {/* Why it could not be pinned, from whoever tried (slice 12). This is what turns
                      the Approximate badge from a verdict into something the author can act on —
                      "nobody pinned this yet" and "this was examined and cannot be pinned" are the
                      same missing pinned form, and they ask opposite things of them. */}
                  {a.unpinnableReason && (
                    <p className={styles.unpinnableReason}>
                      <span className={styles.unpinnableLabel}>Couldn’t be pinned</span>{" "}
                      {a.unpinnableReason}
                    </p>
                  )}
                  {/* …and, for an approximate check, exactly what would make it exact — so the
                      author can rephrase rather than just be told it is second-best. */}
                  {a.pinningHelp && <p className={styles.pinningHelp}>{a.pinningHelp}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
