import type { RepairChangeDiff, RepairStepDiff } from "@varys/review-contract";
import { Badge, ChevronDown, ChevronRight, cx } from "@varys/ui";
import styles from "./styles.module.scss";

/**
 * The side-by-side locator diff a repair is accepted or rejected on (Slice 19, slice 13).
 *
 * The design's whole review gate rests on this being a seconds-long decision, so the surface is
 * built around one question — **what moved?** — and answers it before anything else:
 *
 *  - Signals that CHANGED are listed first and marked; the ones that did not follow, quieter.
 *    Both are shown, because "role is still button, still inside #form-panel, only the name
 *    changed" is the evidence that this is the same control, and a changes-only list would leave a
 *    reviewer unable to see it.
 *  - A dropped signal reads `none` rather than vanishing. Losing a `data-testid` is one of the
 *    most consequential things a repair can do.
 *  - A change OUTSIDE the locator signals is called out. A locator repair should not be editing a
 *    url or a checkpoint name, and a reviewer shown only signals would never learn that it did.
 *
 * Open by default: a diff behind a click is a diff nobody reads, and bulk-accepting without
 * reading is functionally the same as having no gate at all.
 */
export function SignalDiff({
  diff,
  version,
  previousVersion,
}: {
  diff: RepairChangeDiff;
  version: number;
  previousVersion: number | null;
}) {
  const countMismatch = diff.stepCountBefore !== diff.stepCountAfter;

  if (diff.steps.length === 0 && !countMismatch) {
    return (
      <p className={styles.nothing}>
        This version's definition is identical to the one before it — the repair changed nothing.
      </p>
    );
  }

  return (
    <details className={styles.wrap} open>
      <summary className={styles.summary}>
        <ChevronDown size={14} className={styles.chevron} />
        What the repair changed
        <span className={styles.summaryCount}>
          {diff.steps.length} step{diff.steps.length === 1 ? "" : "s"}
        </span>
      </summary>

      {countMismatch && (
        <p className={styles.alarm}>
          The repair changed the number of steps — {diff.stepCountBefore} before,{" "}
          {diff.stepCountAfter} after. A locator repair does not add or remove steps.
        </p>
      )}

      {diff.steps.map((step) => (
        <StepDiff
          key={step.stepIndex}
          step={step}
          version={version}
          previousVersion={previousVersion}
        />
      ))}
    </details>
  );
}

function StepDiff({
  step,
  version,
  previousVersion,
}: {
  step: RepairStepDiff;
  version: number;
  previousVersion: number | null;
}) {
  // Changed first: a reviewer scanning eleven rows for the one that moved is the failure mode
  // this ordering exists to prevent.
  const changed = step.signals.filter((s) => s.changed);
  const same = step.signals.filter((s) => !s.changed);

  return (
    <div className={styles.step}>
      <div className={styles.stepHead}>
        <span className={styles.stepIndex}>Step {step.stepIndex + 1}</span>
        <span className={styles.stepLabel}>{step.beforeLabel}</span>
        {step.afterLabel !== step.beforeLabel && (
          <>
            <ChevronRight size={13} className={styles.arrow} />
            <span className={cx(styles.stepLabel, styles.stepLabelAfter)}>{step.afterLabel}</span>
          </>
        )}
      </div>

      {step.nonSignalChange && (
        <p className={styles.alarm}>
          This step also changed outside its locator signals — a repair that edits a url, a typed
          value or a checkpoint name is doing more than re-finding an element.
        </p>
      )}

      {step.signals.length === 0 ? (
        <p className={styles.nothing}>This step has no element target, so there is no locator to compare.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.thSignal}>Signal</th>
              <th>Before{previousVersion !== null && ` · v${previousVersion}`}</th>
              <th>After · v{version}</th>
            </tr>
          </thead>
          <tbody>
            {[...changed, ...same].map((s) => (
              <tr key={s.label} className={cx(styles.row, s.changed && styles.rowChanged)}>
                <th className={styles.tdSignal} scope="row">
                  {s.label}
                  {s.changed && (
                    <Badge tone="warning" appearance="soft" size="sm">
                      changed
                    </Badge>
                  )}
                </th>
                <td className={cx(styles.value, s.changed && styles.valueBefore)}>
                  <Value text={s.before} />
                </td>
                <td className={cx(styles.value, s.changed && styles.valueAfter)}>
                  <Value text={s.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** A signal, or the fact that there isn't one. `none` is said in words rather than left blank:
 *  an empty cell reads as "we didn't look". */
function Value({ text }: { text: string | null }) {
  if (text === null) return <span className={styles.none}>none</span>;
  return <code className={styles.code}>{text}</code>;
}
