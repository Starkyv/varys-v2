import type { FolderSummary, TestSchedule, TestSummary } from "@varys/review-contract";
import { AlertTriangle, Button, Check, cx, Folder, Input, Lock, Skeleton, Sparkles, Squares } from "@varys/ui";
import { useMemo, useState } from "react";
import { ScheduleEditor } from "../../../../components/ScheduleEditor";
import { useConfirm } from "../../../../context/confirm";
import { useToast } from "../../../../context/toast";
import { draftToInput, type ScheduleDraft } from "../../../../lib/cron";
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
      initialSchedule={null}
      initialInstructions=""
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
      initialSchedule={suite.data.schedule}
      initialInstructions={suite.data.agentInstructions ?? ""}
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
  initialSchedule,
  initialInstructions,
  onClose,
}: {
  suiteId: string | null;
  initialName: string;
  initialTestIds: string[];
  initialFolderIds: string[];
  initialSchedule: TestSchedule | null;
  initialInstructions: string;
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
  const [instructions, setInstructions] = useState(initialInstructions);

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

  // Who the AI instructions would actually reach. Counted off the EXPLICIT selection, because
  // that is what the composition path reads: a folder is a standing selection and deliberately
  // drops Agent-Driven Tests, so counting a folder-derived one here would promise a layer that
  // never arrives.
  const agentMembers = useMemo(
    () => allTests.filter((t) => t.kind === "agent" && selectedTests.has(t.id)),
    [allTests, selectedTests],
  );

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
    const agentInstructions = instructions.trim() || null;
    const onError = (e: unknown) => toast(e instanceof Error ? e.message : "Save failed");
    const n = effectiveIds.size;
    const done = (verb: string) => {
      toast(`Suite ${verb} · ${n} test${n === 1 ? "" : "s"}`);
      onClose();
    };
    if (suiteId) {
      update.mutate(
        { id: suiteId, body: { name: trimmed, testIds, folderIds, agentInstructions } },
        { onSuccess: () => done("saved"), onError },
      );
    } else {
      create.mutate(
        { name: trimmed, testIds, folderIds, agentInstructions },
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
          // An Agent-Driven Test runs on the author's own local Claude, so nothing here can run
          // one unattended and the server refuses it at Save. Shown but not selectable, rather
          // than hidden: "why is that test not in the list?" is a worse question than a row that
          // says why. Disabling it is also what keeps the AI-instructions warning below honest —
          // otherwise picking one would claim a member the save is about to reject.
          const ineligible = t.kind === "agent";
          return (
            <button
              key={t.id}
              type="button"
              disabled={ineligible}
              title={
                ineligible
                  ? "Agent-Driven tests run on your own local Claude, so a suite cannot run one."
                  : undefined
              }
              className={cx(
                styles.row,
                (sel || viaFolder) && styles.rowSel,
                ineligible && styles.rowOff,
              )}
              onClick={() => toggleTest(t.id)}
            >
              <span className={cx(styles.check, (sel || viaFolder) && styles.checkOn)}>
                {(sel || viaFolder) && <Check size={11} />}
              </span>
              <span className={styles.testName}>{t.name}</span>
              {ineligible && <span className={styles.folderCount}>agent-driven</span>}
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

      {/* The outermost of the three AI Instructions layers. Saved with the membership Save above,
          because it IS a property of the suite rather than an independent object like a schedule. */}
      <div className={styles.aiSection}>
        <div className={styles.aiHead}>
          <Sparkles size={14} />
          <span className={styles.aiTitle}>AI instructions</span>
          <span className={styles.aiScope}>environmental context, not overrides</span>
        </div>
        <p className={styles.aiHint}>
          Shared context for the Agent-Driven tests in this suite — which app, which account, what
          to ignore. It is added <em>above</em> each test’s own instructions and never replaces
          them: describe the surroundings here, not how a particular journey should go.
        </p>
        <textarea
          className={styles.aiTextarea}
          rows={5}
          value={instructions}
          placeholder={
            "App is staging.acme.io. Log in as qa@acme.io / hunter2-staging.\nDismiss the cookie banner if it appears. Ignore the “What’s new” modal."
          }
          onChange={(e) => setInstructions(e.target.value)}
          aria-label="Suite AI instructions"
        />
        {agentMembers.length === 0 ? (
          // Said whether or not anything has been typed yet, because the point is to stop the
          // instructions being written at all rather than to report afterwards that they did
          // nothing. Today this is every suite: an Agent-Driven Test cannot join one, because
          // nothing can run it unattended.
          <p className={cx(styles.aiNote, styles.aiWarn)}>
            <AlertTriangle size={13} />
            <span>
              These instructions apply to nothing. Every member of this suite is a pinned test —
              replayed from recorded steps with no model call — so there is nothing here to read
              them. Only Agent-Driven tests are given AI instructions, and one cannot join a suite
              yet.
            </span>
          </p>
        ) : (
          <p className={styles.aiNote}>
            Applies to {agentMembers.length} Agent-Driven test
            {agentMembers.length === 1 ? "" : "s"} in this suite. The pinned members are unaffected.
          </p>
        )}
      </div>

      {/* Scheduling is a separate concern with its own Save — a schedule can only attach to a
          saved suite, so it's edit-mode only, and sits at the end as a compact section. */}
      {suiteId && (
        <div className={styles.scheduleSection}>
          <SuiteScheduleCard suiteId={suiteId} schedule={initialSchedule} />
        </div>
      )}
    </div>
  );
}

/** Cron schedule for a whole suite — fires a suite run (fan-out to every member test) on its
 *  cadence. Mirrors the test-detail ScheduleCard: it saves independently of the suite's
 *  membership Save, through the same `PUT /suites/:id` (`schedule` is a partial field). */
function SuiteScheduleCard({ suiteId, schedule }: { suiteId: string; schedule: TestSchedule | null }) {
  const { toast } = useToast();
  const update = useUpdateSuite();
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);

  function onSave() {
    if (!draft || draft.error) return;
    update.mutate(
      { id: suiteId, body: { schedule: draftToInput(draft) } },
      {
        onSuccess: () => toast(draft.enabled ? "Schedule saved" : "Schedule saved — paused"),
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t save the schedule"),
      },
    );
  }

  function onRemove() {
    update.mutate(
      { id: suiteId, body: { schedule: null } },
      {
        onSuccess: () => toast("Schedule removed"),
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t remove the schedule"),
      },
    );
  }

  return (
    <>
      <ScheduleEditor
        initialSchedule={schedule}
        title="Schedule"
        subtitle="Run this whole suite automatically on a cron. Off by default; a scheduled run fans out to every member test, just like a manual suite run."
        onChange={setDraft}
        collapseWhenOff
      />
      <div className={styles.schedActions}>
        {schedule && (
          <Button variant="ghost" size="sm" disabled={update.isPending} onClick={onRemove}>
            Remove schedule
          </Button>
        )}
        <span className={styles.schedActionsSpacer} />
        <Button
          variant="primary"
          size="sm"
          disabled={!draft || !!draft.error || update.isPending}
          loading={update.isPending}
          onClick={onSave}
        >
          Save schedule
        </Button>
      </div>
    </>
  );
}
