import type { FolderSummary, TestSummary } from "@varys/review-contract";
import { Button, Check, cx, Folder, Input, Lock, Skeleton, Squares } from "@varys/ui";
import { useMemo, useState } from "react";
import { useConfirm } from "../../../../context/confirm";
import { useToast } from "../../../../context/toast";
import {
  useCreateSuite,
  useDeleteSuite,
  useFolders,
  useSuite,
  useTests,
  useUpdateSuite,
} from "../../../../queries";
import styles from "./styles.module.scss";

/** Branch on create vs edit so each path calls its hooks unconditionally. */
export function SuiteEditor({ suiteId, onClose }: { suiteId: string | null; onClose: () => void }) {
  if (suiteId) return <EditExisting suiteId={suiteId} onClose={onClose} />;
  return (
    <EditorForm
      suiteId={null}
      initialName=""
      initialTestIds={[]}
      initialFolderIds={[]}
      onClose={onClose}
    />
  );
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
      initialTestIds={suite.data.testIds}
      initialFolderIds={suite.data.folderIds}
      onClose={onClose}
    />
  );
}

/** All descendant folder ids (inclusive) of the given roots — folders nest, so picking a folder
 *  includes its whole subtree (matches the server's resolution). */
function subtreeOf(rootIds: Set<string>, folders: FolderSummary[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    children.set(f.parentId, [...(children.get(f.parentId) ?? []), f.id]);
  }
  const out = new Set<string>();
  const stack = [...rootIds];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

function EditorForm({
  suiteId,
  initialName,
  initialTestIds,
  initialFolderIds,
  onClose,
}: {
  suiteId: string | null;
  initialName: string;
  initialTestIds: string[];
  initialFolderIds: string[];
  onClose: () => void;
}) {
  const tests = useTests();
  const folders = useFolders();
  const create = useCreateSuite();
  const update = useUpdateSuite();
  const remove = useDeleteSuite();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [name, setName] = useState(initialName);
  const [selectedTests, setSelectedTests] = useState<Set<string>>(() => new Set(initialTestIds));
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(
    () => new Set(initialFolderIds),
  );

  const saving = create.isPending || update.isPending;
  const allTests = tests.data ?? [];
  const allFolders = folders.data ?? [];

  // The EFFECTIVE tests: every test whose folder is in a selected folder's subtree, plus the
  // individually-picked tests — deduped. Mirrors the server so the count matches what runs.
  const effectiveIds = useMemo(() => {
    const subtree = subtreeOf(selectedFolders, allFolders);
    const ids = new Set(selectedTests);
    if (subtree.size > 0) {
      for (const t of allTests) if (t.folderId && subtree.has(t.folderId)) ids.add(t.id);
    }
    return ids;
  }, [selectedFolders, selectedTests, allTests, allFolders]);

  function toggleTest(id: string) {
    setSelectedTests((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleFolder(id: string) {
    setSelectedFolders((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function save() {
    const trimmed = name.trim() || "Untitled suite";
    const testIds = [...selectedTests];
    const folderIds = [...selectedFolders];
    const onError = (e: unknown) => toast(e instanceof Error ? e.message : "Save failed");
    const n = effectiveIds.size;
    const done = (verb: string) => {
      toast(`Suite ${verb} · ${n} test${n === 1 ? "" : "s"}`);
      onClose();
    };
    if (suiteId) {
      update.mutate(
        { id: suiteId, body: { name: trimmed, testIds, folderIds } },
        { onSuccess: () => done("saved"), onError },
      );
    } else {
      create.mutate(
        { name: trimmed, testIds, folderIds },
        { onSuccess: () => done(`“${trimmed}” created`), onError },
      );
    }
  }

  async function onDelete() {
    if (!suiteId) return;
    const ok = await confirm({
      title: `Delete suite “${name}”?`,
      message: "The suite is removed. Its member tests and folders are not deleted.",
      confirmLabel: "Delete suite",
      tone: "danger",
    });
    if (!ok) return;
    remove.mutate(suiteId, {
      onSuccess: () => {
        toast(`Suite “${name}” deleted`);
        onClose();
      },
      onError: (e) => toast(e instanceof Error ? e.message : "Delete failed"),
    });
  }

  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <Squares size={18} />
        </span>
        <Input
          className={styles.nameInput}
          inputSize="sm"
          placeholder="Suite name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Suite name"
        />
        <span className={styles.count}>{effectiveIds.size} tests</span>
        {suiteId && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onDelete()}
            loading={remove.isPending}
            className={styles.delete}
          >
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
        {/* Folders — including a folder pulls in all its tests (and subfolders), dynamically. */}
        <div className={styles.sectionLabel}>
          Folders
          <span className={styles.sectionHint}>include every test in the folder</span>
        </div>
        {allFolders.map((f: FolderSummary) => {
          const sel = selectedFolders.has(f.id);
          return (
            <button
              key={f.id}
              type="button"
              className={cx(styles.row, sel && styles.rowSel)}
              onClick={() => toggleFolder(f.id)}
            >
              <span className={cx(styles.check, sel && styles.checkOn)}>
                {sel && <Check size={11} />}
              </span>
              <span className={styles.icon} aria-hidden>
                <Folder size={14} />
              </span>
              <span className={styles.testName}>{f.name}</span>
              <span className={styles.folderCount}>
                {f.testCount} test{f.testCount === 1 ? "" : "s"}
              </span>
            </button>
          );
        })}
        {allFolders.length === 0 && <div className={styles.empty}>No folders yet.</div>}

        {/* Tests — pick individual (standalone) tests, on top of any folders above. */}
        <div className={styles.sectionLabel}>
          Tests
          <span className={styles.sectionHint}>add individual tests</span>
        </div>
        {allTests.map((t: TestSummary) => {
          const sel = selectedTests.has(t.id);
          // Already covered by a selected folder — shown as included; toggling still adds it
          // explicitly, so it stays if that folder is later removed.
          const viaFolder = !sel && effectiveIds.has(t.id);
          return (
            <button
              key={t.id}
              type="button"
              className={cx(styles.row, (sel || viaFolder) && styles.rowSel)}
              onClick={() => toggleTest(t.id)}
            >
              <span className={cx(styles.check, (sel || viaFolder) && styles.checkOn)}>
                {(sel || viaFolder) && <Check size={11} />}
              </span>
              <span className={styles.testName}>{t.name}</span>
              {viaFolder && <span className={styles.folderCount}>via folder</span>}
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
        {allTests.length === 0 && <div className={styles.empty}>No tests to add yet.</div>}
      </div>
    </div>
  );
}
