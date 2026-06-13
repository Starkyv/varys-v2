import { Button, Check, Eye, EmptyState, ErrorState, Skeleton } from "@varys/ui";
import { motion, useReducedMotion } from "framer-motion";
import { LiveIndicator } from "../../components/LiveIndicator";
import { useRouter } from "../../context/router";
import { relativeTime } from "../../lib/format";
import { StatusIcon, statusLabel, statusVars } from "../../lib/status";
import { useNeedsReview } from "../../queries";
import styles from "./styles.module.scss";

export function NeedsReview() {
  const queue = useNeedsReview();
  const { navigate } = useRouter();
  const reduce = useReducedMotion();

  if (queue.isLoading) {
    return (
      <div className={styles.loading}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={80} radius="var(--radius-xl)" />
        ))}
      </div>
    );
  }

  if (queue.isError) {
    return (
      <ErrorState
        title="Review queue unavailable"
        description="GET /runs/needs-review failed to load."
        onRetry={() => queue.refetch()}
      />
    );
  }

  const data = queue.data ?? [];
  if (data.length === 0) {
    return (
      <EmptyState
        icon={<Check />}
        tone="success"
        title="All caught up"
        description="No checkpoints are waiting on a decision. New diffs and baselines will land here for triage."
      />
    );
  }

  return (
    <div>
      <div className={styles.head}>
        <span className={styles.count}>
          <strong>{data.length}</strong> checkpoint{data.length === 1 ? "" : "s"} awaiting a decision
        </span>
        <span className={styles.spacer} />
        <LiveIndicator />
      </div>
      <div className={styles.list}>
        {data.map((n, i) => {
          const vars = statusVars(n.reviewState);
          return (
            <motion.div
              key={`${n.runId}-${n.checkpointName}`}
              className={styles.row}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: Math.min(i, 8) * 0.04 }}
            >
              <span className={styles.glyph} style={{ background: vars.soft, color: vars.fg }}>
                <StatusIcon status={n.reviewState} size={19} />
              </span>
              <div className={styles.body}>
                <div className={styles.titleRow}>
                  <span className={styles.cpName}>{n.checkpointName}</span>
                  <span className={styles.stateBadge} style={{ background: vars.soft, color: vars.fg }}>
                    {statusLabel(n.reviewState)}
                  </span>
                </div>
                <div className={styles.meta}>
                  {n.testName} · <span className={styles.env}>{n.environment}</span> · {relativeTime(n.runTimestamp)}
                </div>
              </div>
              <Button variant="primary" iconLeft={<Eye size={15} />} onClick={() => navigate({ name: "runDetail", runId: n.runId })}>
                Review
              </Button>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
