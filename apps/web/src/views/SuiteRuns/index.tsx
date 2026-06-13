import { EmptyState, ErrorState, ListRun, Skeleton } from "@varys/ui";
import { useRouter } from "../../context/router";
import { useSuiteRuns } from "../../queries";
import { SuiteRunReportPanel } from "./components/SuiteRunReportPanel";
import { SuiteRunRow } from "./components/SuiteRunRow";
import styles from "./styles.module.scss";

export function SuiteRuns() {
  const suiteRuns = useSuiteRuns();
  const { route, navigate } = useRouter();
  const routeSelected = route.name === "suiteRuns" ? route.suiteRunId : undefined;

  if (suiteRuns.isLoading) {
    return (
      <div className={styles.layout}>
        <Skeleton height={300} radius="var(--radius-xl)" />
        <Skeleton height={300} radius="var(--radius-xl)" />
      </div>
    );
  }

  if (suiteRuns.isError) {
    return <ErrorState title="Couldn’t load suite runs" onRetry={() => suiteRuns.refetch()} />;
  }

  const data = suiteRuns.data ?? [];
  if (data.length === 0) {
    return (
      <EmptyState
        icon={<ListRun />}
        tone="neutral"
        title="No suite runs yet"
        description="Run a suite across one or more environments to see the aggregated report here."
      />
    );
  }

  const selectedId = routeSelected && data.some((r) => r.suiteRunId === routeSelected) ? routeSelected : data[0].suiteRunId;

  return (
    <div className={styles.layout}>
      <div className={styles.list}>
        {data.map((run) => (
          <SuiteRunRow
            key={run.suiteRunId}
            run={run}
            selected={run.suiteRunId === selectedId}
            onSelect={() => navigate({ name: "suiteRuns", suiteRunId: run.suiteRunId })}
          />
        ))}
      </div>
      <SuiteRunReportPanel id={selectedId} />
    </div>
  );
}
