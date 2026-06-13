import type { SuiteSummary } from "@varys/review-contract";
import { EmptyState, ErrorState, Plus, Skeleton, Squares } from "@varys/ui";
import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { useSuites } from "../../queries";
import { SuiteCard } from "./components/SuiteCard";
import { SuiteEditor } from "./components/SuiteEditor";
import { SuiteRunDialog, type SuiteRunTarget } from "./components/SuiteRunDialog";
import styles from "./styles.module.scss";

export function Suites() {
  const suites = useSuites();
  const reduce = useReducedMotion();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [runTarget, setRunTarget] = useState<SuiteRunTarget | null>(null);

  function openEditor(id: string | null) {
    setEditId(id);
    setEditorOpen(true);
  }

  if (editorOpen) {
    return <SuiteEditor suiteId={editId} onClose={() => setEditorOpen(false)} />;
  }

  if (suites.isLoading) {
    return (
      <div className={styles.grid}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={150} radius="var(--radius-xl)" />
        ))}
      </div>
    );
  }

  if (suites.isError) {
    return <ErrorState title="Couldn’t load suites" onRetry={() => suites.refetch()} />;
  }

  const data = suites.data ?? [];
  if (data.length === 0) {
    return (
      <EmptyState
        icon={<Squares />}
        title="No suites yet"
        description="Group tests into a suite to run them together across environments."
        action={
          <button type="button" className={styles.newInline} onClick={() => openEditor(null)}>
            <Plus size={15} />
            New suite
          </button>
        }
      />
    );
  }

  return (
    <>
      <div className={styles.grid}>
        {data.map((suite: SuiteSummary, i) => (
          <motion.div
            key={suite.id}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.28, delay: Math.min(i, 8) * 0.04 }}
          >
            <SuiteCard suite={suite} onRun={() => setRunTarget(suite)} onEdit={() => openEditor(suite.id)} />
          </motion.div>
        ))}
        <button type="button" className={styles.newTile} onClick={() => openEditor(null)}>
          <Plus size={22} />
          <span>New suite</span>
        </button>
      </div>
      <SuiteRunDialog suite={runTarget} onClose={() => setRunTarget(null)} />
    </>
  );
}
