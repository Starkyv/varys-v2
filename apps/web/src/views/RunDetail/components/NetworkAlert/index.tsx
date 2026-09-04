import type { RunView } from "@varys/review-contract";
import { AlertTriangle, cx } from "@varys/ui";
import { duration } from "../../../../lib/format";
import { runNetworkProblems, shortUrl, statusToken } from "../../network";
import styles from "./styles.module.scss";

/**
 * The run-level "this may not be what the label says" card.
 *
 * Shown on a FAILED run that also saw failed API requests, and worded as a possibility rather
 * than a verdict — because the causal link genuinely cannot be established from what we record.
 * `failureKind` comes from the thrown exception's TYPE, so a step whose element never rendered
 * for want of data is classified `locator`, identically to a renamed button. And the failed
 * request is usually on an EARLIER step than the failing one (the click that loads a table fails;
 * the next step can't find a row), so no per-step view can draw the line either.
 *
 * What this can honestly do is put both facts in front of the reader before they start editing
 * selectors. It changes nothing about how the run is classified, queued or repaired.
 */
export function NetworkAlert({ run }: { run: RunView }) {
  const problems = runNetworkProblems(run);
  if (problems.length === 0) return null;

  // Step labels, so a row reads "during click "Search"" rather than "step 3".
  const labelByIndex = new Map(run.steps.map((s) => [s.index, s.label]));
  const locatorLabelled = run.failureKind === "locator";

  return (
    <section className={styles.card} aria-labelledby="network-alert-title">
      <header className={styles.header}>
        <span className={styles.icon}>
          <AlertTriangle size={20} />
        </span>
        <div>
          <h2 className={styles.title} id="network-alert-title">
            {problems.length === 1
              ? "An API request failed during this run"
              : `${problems.length} API requests failed during this run`}
          </h2>
          <p className={styles.body}>
            {locatorLabelled
              ? "This run is recorded as a locator failure, but a missing element and a failed data call are indistinguishable to the matcher — an element that never rendered looks exactly like one that was renamed. Rule these out before re-pinning anything."
              : "Worth ruling out before treating the failure as a problem with the test — a step that had no data to work with fails in whatever way its assertions happen to catch."}
          </p>
        </div>
      </header>

      <ul className={styles.list}>
        {problems.map((event, i) => {
          const label = event.stepIndex != null ? labelByIndex.get(event.stepIndex) : null;
          return (
            <li className={styles.item} key={`${event.startedAt}-${i}`}>
              <span className={styles.status}>{statusToken(event)}</span>
              <span className={styles.method}>{event.method}</span>
              <code className={cx(styles.url)} title={event.url}>
                {shortUrl(event.url)}
              </code>
              <span className={styles.during}>
                {label
                  ? `during ${label}`
                  : event.stepIndex != null
                    ? `during step ${event.stepIndex + 1}`
                    : "outside any step"}
              </span>
              <span className={styles.timing}>{duration(event.durationMs)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
