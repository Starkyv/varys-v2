import type { NeedsReviewItem } from "@varys/review-contract";
import { useNeedsReview } from "./queries";
import styles from "./NeedsReviewList.module.css";

/** Why a checkpoint is in the queue — shown so a reviewer can triage what to open. */
const REASON: Record<NeedsReviewItem["reviewState"], string> = {
  "pending-baseline": "Awaiting first approval",
  diff: "Visual diff",
};

/**
 * The humble "needs review" list — the way in. Shows the checkpoints currently in
 * `pending-baseline` or `diff` state so a reviewer can find work without knowing
 * run ids. A flat list, not the slice-7 dashboard. Each entry links into the
 * diff viewer; after a decision the list query is invalidated so resolved items
 * drop off, and an empty state shows when nothing is left.
 */
export function NeedsReviewList() {
  const { data, isLoading, isError, error } = useNeedsReview();

  if (isLoading) {
    return (
      <p role="status" className={styles.notice}>
        Loading review queue…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className={styles.error}>
        Couldn’t load the review queue: {(error as Error).message}
      </p>
    );
  }
  if (!data) return null;
  if (data.length === 0) {
    return <p className={styles.empty}>Nothing needs review — you’re all caught up.</p>;
  }

  return (
    <main className={styles.list}>
      <h1>Needs review</h1>
      <ul className={styles.items}>
        {data.map((it) => (
          <li key={`${it.runId}:${it.checkpointName}`}>
            <a className={styles.row} href={`?run=${it.runId}`}>
              <span className={styles.test}>{it.testName}</span>
              <span className={styles.checkpoint}>{it.checkpointName}</span>
              <span className={styles.env}>{it.environment}</span>
              <span className={styles.time}>{new Date(it.runTimestamp).toLocaleString()}</span>
              <span className={styles.reason}>{REASON[it.reviewState]}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
