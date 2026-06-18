import { Activity, EmptyState, ErrorState, IconButton, Skeleton, Trash } from "@varys/ui";
import { LiveIndicator } from "../../components/LiveIndicator";
import { useConfirm } from "../../context/confirm";
import { useRouter } from "../../context/router";
import { useToast } from "../../context/toast";
import { relativeTime } from "../../lib/format";
import { StatusBadge } from "../../lib/status";
import { useDeleteRun, useRuns } from "../../queries";
import styles from "./styles.module.scss";

export function Runs() {
  const runs = useRuns();
  const { navigate } = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const del = useDeleteRun();

  async function onDelete(runId: string, testName: string) {
    const ok = await confirm({
      title: "Delete run?",
      message: `This deletes the run of “${testName}” — its screenshots and history are removed (baselines are kept). This can’t be undone.`,
      confirmLabel: "Delete run",
      tone: "danger",
    });
    if (!ok) return;
    del.mutate(runId, {
      onSuccess: () => toast("Run deleted"),
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t delete run"),
    });
  }

  if (runs.isLoading) {
    return (
      <div className={styles.loading}>
        {[40, 52, 52, 52, 52].map((h, i) => (
          <Skeleton key={i} height={h} radius="var(--radius-md)" />
        ))}
      </div>
    );
  }

  if (runs.isError) {
    return (
      <ErrorState
        title="Run history unavailable"
        description="Polling GET /runs failed. It will keep retrying automatically."
        onRetry={() => runs.refetch()}
        retryLabel="Retry now"
      />
    );
  }

  const data = runs.data ?? [];
  if (data.length === 0) {
    return (
      <EmptyState
        icon={<Activity />}
        tone="neutral"
        title="No runs yet"
        description="Trigger a test to see its replay appear here, newest first, with live status."
      />
    );
  }

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <h3 className={styles.title}>All runs</h3>
        <span className={styles.count}>{data.length} runs</span>
        <span className={styles.spacer} />
        <LiveIndicator label="Live · polling every 3s" />
      </header>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.thLeft}>Test</th>
              <th>Environment</th>
              <th>Status</th>
              <th className={styles.thRight}>When</th>
              <th className={styles.thAction} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((r) => {
              const inFlight = r.status === "queued" || r.status === "running";
              return (
                <tr
                  key={r.runId}
                  tabIndex={0}
                  className={styles.row}
                  onClick={() => navigate({ name: "runDetail", runId: r.runId })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") navigate({ name: "runDetail", runId: r.runId });
                  }}
                >
                  <td className={styles.tdTest}>
                    <div className={styles.testName}>{r.testName}</div>
                    {r.error && <div className={styles.error}>{r.error}</div>}
                  </td>
                  <td className={styles.env}>{r.environment}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className={styles.when}>{relativeTime(r.runTimestamp)}</td>
                  <td className={styles.tdAction}>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      icon={<Trash size={15} />}
                      label={inFlight ? "Can’t delete a run that’s still in progress" : "Delete run"}
                      className={styles.deleteBtn}
                      disabled={inFlight || del.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDelete(r.runId, r.testName);
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
