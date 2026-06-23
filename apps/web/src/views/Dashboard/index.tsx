import type { DashboardSummary } from "@varys/review-contract";
import { Check, ErrorState, Eye, Flask, Skeleton, X } from "@varys/ui";
import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { useDashboard } from "../../queries";
import { AlertsPanel } from "./components/AlertsPanel";
import { DiffTrend } from "./components/DiffTrend";
import { KpiCard } from "./components/KpiCard";
import { RecentRuns } from "./components/RecentRuns";
import { StatusMatrix } from "./components/StatusMatrix";
import styles from "./styles.module.scss";
import type { Kpi } from "./types";

const KPI_SKELETONS = ["total", "pass", "review", "fail"];

/** Map the API's raw summary figures into the KPI cards' display props (the icon
 *  is a React component, so it's attached here rather than coming from the API). */
function toKpis(s: DashboardSummary): Kpi[] {
  return [
    {
      label: "Total tests",
      value: `${s.totalTests}`,
      delta: `${s.totalTestsDelta >= 0 ? "+" : ""}${s.totalTestsDelta}`,
      deltaTone: "success",
      deltaDir: s.totalTestsDelta < 0 ? "down" : "up",
      sub: `across ${s.environmentsCount} environment${s.environmentsCount === 1 ? "" : "s"}`,
      Icon: Flask,
    },
    {
      label: "Pass rate",
      value: `${(s.passRate * 100).toFixed(1)}%`,
      delta: `${Math.abs(s.passRateDeltaPct).toFixed(1)}%`,
      deltaTone: s.passRateDeltaPct < 0 ? "danger" : "success",
      deltaDir: s.passRateDeltaPct < 0 ? "down" : "up",
      sub: "verifications · last 7 days",
      Icon: Check,
    },
    {
      label: "Needs review",
      value: `${s.needsReview}`,
      delta: `+${s.needsReviewDelta}`,
      deltaTone: "warning",
      deltaDir: "up",
      sub: "checkpoints pending",
      Icon: Eye,
    },
    {
      label: "Failures",
      value: `${s.failures24h}`,
      delta: `${Math.abs(s.failures24hDelta)}`,
      deltaTone: "danger",
      deltaDir: s.failures24hDelta < 0 ? "down" : "up",
      sub: "in the last 24h",
      Icon: X,
    },
  ];
}

/** A staggered entrance wrapper — each block fades/rises in sequence. */
function Reveal({ index, children }: { index: number; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, delay: index * 0.05, ease: [0.2, 0, 0, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function Dashboard() {
  const dash = useDashboard();
  const summary = dash.data?.summary;
  const kpis = summary ? toKpis(summary) : [];

  return (
    <div className={styles.dashboard}>
      <div className={styles.kpiGrid}>
        {dash.isLoading ? (
          KPI_SKELETONS.map((id, i) => (
            <Reveal key={id} index={i}>
              <Skeleton height={116} radius="var(--radius-xl)" />
            </Reveal>
          ))
        ) : dash.isError || !summary ? (
          <div className={styles.kpiError}>
            <ErrorState title="Couldn’t load dashboard metrics" onRetry={() => dash.refetch()} />
          </div>
        ) : (
          kpis.map((kpi, i) => (
            <Reveal key={kpi.label} index={i}>
              <KpiCard kpi={kpi} />
            </Reveal>
          ))
        )}
      </div>

      <div className={styles.matrixRow}>
        <Reveal index={4}>
          <StatusMatrix
            matrix={dash.data?.matrix}
            loading={dash.isLoading}
            error={dash.isError}
            onRetry={() => dash.refetch()}
          />
        </Reveal>
        <Reveal index={5}>
          <AlertsPanel />
        </Reveal>
      </div>

      <div className={styles.splitRow}>
        <Reveal index={6}>
          <RecentRuns
            runs={dash.data?.recentRuns ?? []}
            loading={dash.isLoading}
            error={dash.isError}
            onRetry={() => dash.refetch()}
          />
        </Reveal>
        <Reveal index={7}>
          <DiffTrend
            trends={dash.data?.trends}
            loading={dash.isLoading}
            error={dash.isError}
            onRetry={() => dash.refetch()}
          />
        </Reveal>
      </div>
    </div>
  );
}
