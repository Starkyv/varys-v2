import type { RunNetworkEvent } from "@varys/review-contract";
import { ChevronDown, cx, Globe } from "@varys/ui";
import { duration } from "../../../../lib/format";
import { isProblemRequest, shortUrl, statusToken } from "../../network";
import styles from "./styles.module.scss";

/**
 * The API requests one step made — a factual record, deliberately making no causal claim.
 *
 * The causal claim lives at run level ({@link NetworkAlert}), because it cannot be made here.
 * The usual shape of a data-caused failure is a request that fails during step N (the click that
 * loads a table) and a step N+1 that then can't find a row — so the failed request and the failed
 * step are DIFFERENT steps, and no per-step view can honestly say which caused which. This panel
 * says what happened and when; the reader draws the line.
 *
 * Bounded by the worker: every failed, errored or unanswered request, plus the slowest few
 * successes. A step that made no notable requests renders nothing at all.
 */
export function NetworkPanel({ events }: { events: RunNetworkEvent[] }) {
  if (events.length === 0) return null;
  const problems = events.filter(isProblemRequest);
  const hasProblems = problems.length > 0;

  return (
    <div className={styles.wrap}>
      <details className={styles.more} open={hasProblems}>
        <summary className={styles.summary}>
          <ChevronDown size={14} className={styles.summaryChevron} />
          <Globe size={14} className={styles.summaryGlyph} />
          API requests during this step
          <span className={styles.spacer} />
          {hasProblems && (
            <span className={cx(styles.count, styles.countBad)}>
              {problems.length} failed
            </span>
          )}
          <span className={styles.count}>{events.length} recorded</span>
        </summary>
        <div className={styles.moreBody}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Method</th>
                <th scope="col">Request</th>
                <th scope="col" className={styles.numeric}>
                  Total
                </th>
                <th scope="col" className={styles.numeric}>
                  TTFB
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, i) => {
                const problem = isProblemRequest(event);
                return (
                  <tr key={`${event.startedAt}-${i}`} className={cx(problem && styles.rowBad)}>
                    <td>
                      <span className={cx(styles.status, problem && styles.statusBad)}>
                        {statusToken(event)}
                      </span>
                    </td>
                    <td className={styles.method}>{event.method}</td>
                    <td className={styles.url} title={event.url}>
                      <code>{shortUrl(event.url)}</code>
                    </td>
                    <td className={styles.numeric}>{duration(event.durationMs)}</td>
                    <td className={styles.numeric}>
                      {event.ttfbMs != null ? duration(event.ttfbMs) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className={styles.hint}>
            Requests are attributed to the step that was running when each STARTED. A high TTFB
            with a low total is a slow server; the reverse is a large response. “no response”
            means nothing came back before the run ended — the shape an API timeout takes.
          </p>
        </div>
      </details>
    </div>
  );
}
