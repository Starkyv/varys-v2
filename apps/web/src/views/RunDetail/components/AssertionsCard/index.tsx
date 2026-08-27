import type { AssertionHistoryPoint, AssertionResultView } from "@varys/review-contract";
import { Badge, Card, Check, cx } from "@varys/ui";
import { OUTCOME_META, PinnedAssertion, consequenceOf } from "../../../../components/PinnedAssertion";
import { absoluteTime } from "../../../../lib/format";
import styles from "./styles.module.scss";

/**
 * A run's assertions — each one separately, with its own verdict, the two values it compared, and
 * its own history over time (Slice 19, slice 09).
 *
 * Deliberately NOT part of the checkpoint timeline: an assertion is not a picture, there is no
 * baseline to approve, and there is no decision for the reviewer to take. A failing one has
 * already made the run red. So this reads as evidence, not as a queue.
 *
 * The one distinction the card must never blur is `relation-false` (both values read, and they
 * disagree — the app is wrong) against `extraction-failed` (a value couldn't be read at all — the
 * test is wrong). They carry different tones and different sentences, because they send the reader
 * to different places.
 */
export function AssertionsCard({ assertions }: { assertions: AssertionResultView[] }) {
  if (assertions.length === 0) return null;
  const failing = assertions.filter((a) => a.outcome !== "passed").length;

  return (
    <Card>
      <div className={styles.head}>
        <span className={styles.icon}>
          <Check size={15} />
        </span>
        <div className={styles.headText}>
          <div className={styles.title}>Assertions</div>
          <div className={styles.sub}>
            Checks on a relationship between things on the page — evaluated in the worker, with no
            model call.
          </div>
        </div>
        <span className={styles.count}>
          {failing > 0 ? `${failing} of ${assertions.length} failing` : `${assertions.length} passing`}
        </span>
      </div>

      <ul className={styles.list}>
        {assertions.map((a) => {
          const meta = OUTCOME_META[a.outcome];
          return (
            <li key={a.id} className={cx(styles.item, styles[a.outcome])}>
              <div className={styles.itemHead}>
                <span className={styles.check}>{a.check}</span>
                <Badge tone={meta.tone} size="sm">
                  {meta.label}
                </Badge>
              </div>

              <p className={styles.detail}>{a.detail}</p>

              {a.outcome !== "passed" && (
                <>
                  <p className={styles.blurb}>{meta.blurb}</p>
                  {/* …and what follows from it: which of these is repairable, and which never is. */}
                  <p className={styles.blurb}>{consequenceOf(a.outcome, a.cause)}</p>
                </>
              )}

              {/* What it compared: the values this run actually read, then the pinned form that
                  decided how to read them. */}
              {(a.left !== null || a.right !== null) && (
                <div className={styles.values}>
                  <ValueChip label="Left" value={a.left} />
                  <ValueChip label="Right" value={a.right} />
                </div>
              )}

              <PinnedAssertion pinned={a.pinned} />

              <History assertionId={a.id} points={a.history} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ValueChip({ label, value }: { label: string; value: string | null }) {
  return (
    <span className={styles.valueChip}>
      <span className={styles.valueLabel}>{label}</span>
      {value === null ? (
        <span className={styles.valueNone}>not read</span>
      ) : (
        <code className={styles.valueCode}>{value}</code>
      )}
    </span>
  );
}

/**
 * This assertion's verdicts over time, oldest → newest — the "has this been failing all week, or
 * did it break tonight?" glance. Keyed on the assertion's stable id, so the strip spans every
 * rewording of the check text rather than restarting at one.
 */
function History({ assertionId, points }: { assertionId: string; points: AssertionHistoryPoint[] }) {
  if (points.length <= 1) {
    return (
      <p className={styles.historyEmpty}>First run for this assertion — its history builds from here.</p>
    );
  }
  const passed = points.filter((p) => p.outcome === "passed").length;
  return (
    <div className={styles.history}>
      <span className={styles.historyLabel}>History</span>
      <div className={styles.dots}>
        {points.map((p) => (
          <span
            key={`${assertionId}-${p.runId}`}
            className={cx(styles.dot, styles[`dot_${p.outcome}` as keyof typeof styles])}
            title={`${OUTCOME_META[p.outcome].label} · ${absoluteTime(p.runTimestamp)}`}
          />
        ))}
      </div>
      <span className={styles.historyMeta}>
        {passed} of {points.length} runs passed
      </span>
    </div>
  );
}
