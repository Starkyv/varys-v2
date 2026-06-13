import { Database, ErrorState, Skeleton } from "@varys/ui";
import { useState } from "react";
import { useToast } from "../../context/toast";
import { useCreateEnvironment, useEnvironments } from "../../queries";
import { EnvEditor } from "./components/EnvEditor";
import { EnvRail } from "./components/EnvRail";
import styles from "./styles.module.scss";

export function Environments() {
  const environments = useEnvironments();
  const create = useCreateEnvironment();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (environments.isLoading) {
    return (
      <div className={styles.layout}>
        <Skeleton height={280} radius="var(--radius-xl)" />
        <Skeleton height={360} radius="var(--radius-xl)" />
      </div>
    );
  }

  if (environments.isError) {
    return <ErrorState title="Couldn’t load environments" onRetry={() => environments.refetch()} />;
  }

  const data = environments.data ?? [];
  const selected = data.find((e) => e.id === selectedId) ?? data[0] ?? null;

  function onCreate(name: string) {
    create.mutate(
      { name },
      {
        onSuccess: (res) => {
          toast(`Environment “${name}” created`);
          setSelectedId(res.id);
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t create environment"),
      },
    );
  }

  return (
    <div className={styles.layout}>
      <EnvRail
        environments={data}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        onCreate={onCreate}
        creating={create.isPending}
      />
      {selected ? (
        <EnvEditor key={selected.id} env={selected} onDeleted={() => setSelectedId(null)} />
      ) : (
        <div className={styles.placeholder}>
          <span className={styles.placeholderIcon}>
            <Database size={28} />
          </span>
          <div className={styles.placeholderTitle}>No environments yet</div>
          <div className={styles.placeholderText}>
            Add a deployment with its variable values and secrets so variable tests can run against it.
          </div>
        </div>
      )}
    </div>
  );
}
