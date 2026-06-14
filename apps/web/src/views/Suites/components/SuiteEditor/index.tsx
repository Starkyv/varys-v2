import type { TestSummary } from "@varys/review-contract";
import { Button, Check, cx, Input, Lock, Skeleton, Squares } from "@varys/ui";
import { useState } from "react";
import { useToast } from "../../../../context/toast";
import { useCreateSuite, useDeleteSuite, useSuite, useTests, useUpdateSuite } from "../../../../queries";
import styles from "./styles.module.scss";

/** Branch on create vs edit so each path calls its hooks unconditionally. */
export function SuiteEditor({ suiteId, onClose }: { suiteId: string | null; onClose: () => void }) {
  if (suiteId) return <EditExisting suiteId={suiteId} onClose={onClose} />;
  return <EditorForm suiteId={null} initialName="" initialIds={[]} onClose={onClose} />;
}

function EditExisting({ suiteId, onClose }: { suiteId: string; onClose: () => void }) {
  const suite = useSuite(suiteId);
  if (suite.isLoading || !suite.data) {
    return (
      <div className={styles.loading}>
        <Skeleton height={56} radius="var(--radius-md)" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={44} radius="var(--radius-md)" />
        ))}
      </div>
    );
  }
  return (
    <EditorForm
      key={suiteId}
      suiteId={suiteId}
      initialName={suite.data.name}
      initialIds={suite.data.tests.map((t) => t.id)}
      onClose={onClose}
    />
  );
}

function EditorForm({
  suiteId,
  initialName,
  initialIds,
  onClose,
}: {
  suiteId: string | null;
  initialName: string;
  initialIds: string[];
  onClose: () => void;
}) {
  const tests = useTests();
  const create = useCreateSuite();
  const update = useUpdateSuite();
  const remove = useDeleteSuite();
  const { toast } = useToast();

  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialIds));

  const saving = create.isPending || update.isPending;

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function save() {
    const trimmed = name.trim() || "Untitled suite";
    const testIds = [...selected];
    const onError = (e: unknown) => toast(e instanceof Error ? e.message : "Save failed");
    if (suiteId) {
      update.mutate(
        { id: suiteId, body: { name: trimmed, testIds } },
        { onSuccess: () => { toast(`Suite saved · ${testIds.length} tests`); onClose(); }, onError },
      );
    } else {
      create.mutate(
        { name: trimmed, testIds },
        { onSuccess: () => { toast(`Suite “${trimmed}” created`); onClose(); }, onError },
      );
    }
  }

  function onDelete() {
    if (!suiteId) return;
    if (!window.confirm(`Delete suite “${name}”? Member tests are not deleted.`)) return;
    remove.mutate(suiteId, {
      onSuccess: () => { toast(`Suite “${name}” deleted`); onClose(); },
      onError: (e) => toast(e instanceof Error ? e.message : "Delete failed"),
    });
  }

  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <Squares size={18} />
        </span>
        <Input className={styles.nameInput} inputSize="sm" placeholder="Suite name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Suite name" />
        <span className={styles.count}>{selected.size} selected</span>
        {suiteId && (
          <Button variant="ghost" size="sm" onClick={onDelete} loading={remove.isPending} className={styles.delete}>
            Delete
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={save} loading={saving}>
          Save
        </Button>
      </header>
      <div className={styles.list}>
        {(tests.data ?? []).map((t: TestSummary) => {
          const sel = selected.has(t.id);
          return (
            <button key={t.id} type="button" className={cx(styles.row, sel && styles.rowSel)} onClick={() => toggle(t.id)}>
              <span className={cx(styles.check, sel && styles.checkOn)}>{sel && <Check size={11} />}</span>
              <span className={styles.testName}>{t.name}</span>
              {t.tags.length > 0 && (
                <span className={styles.tags}>
                  {t.tags.map((tag) => (
                    <span key={tag} className={styles.tag}>
                      {tag}
                    </span>
                  ))}
                </span>
              )}
              {t.needsEnvironment && (
                <span className={styles.envBadge}>
                  <Lock size={10} />
                  env
                </span>
              )}
              <span className={styles.folder}>{t.folderName ?? "Unfiled"}</span>
            </button>
          );
        })}
        {(tests.data ?? []).length === 0 && <div className={styles.empty}>No tests to add yet.</div>}
      </div>
    </div>
  );
}
