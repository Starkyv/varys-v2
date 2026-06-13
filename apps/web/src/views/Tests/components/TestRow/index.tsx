import type { FolderSummary, TestSummary } from "@varys/review-contract";
import { Button, Folder, Grip, IconButton, Inbox, Input, Lock, MoreHorizontal, Play, Select } from "@varys/ui";
import { useState } from "react";
import { useToast } from "../../../../context/toast";
import { useUpdateTest } from "../../../../queries";
import { shortDate } from "../../../../lib/format";
import styles from "./styles.module.scss";

export function TestRow({
  test,
  folders,
  allTags,
  isDragging,
  onDragStart,
  onDragEnd,
  onRun,
}: {
  test: TestSummary;
  folders: FolderSummary[];
  allTags: string[];
  isDragging: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onRun: (id: string) => void;
}) {
  const [organizing, setOrganizing] = useState(false);

  return (
    <div className={styles.wrap}>
      <div
        className={styles.row}
        draggable
        style={{ opacity: isDragging ? 0.4 : 1 }}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", test.id);
          onDragStart(test.id);
        }}
        onDragEnd={onDragEnd}
      >
        <span className={styles.grip} aria-hidden>
          <Grip size={16} />
        </span>
        <div className={styles.main}>
          <div className={styles.titleRow}>
            <span className={styles.name}>{test.name}</span>
            {test.needsEnvironment && (
              <span className={styles.envBadge} title="References variables — needs an environment">
                <Lock size={11} />
                env
              </span>
            )}
          </div>
          <div className={styles.meta}>
            <span className={styles.folder}>
              {test.folderId ? <Folder size={13} /> : <Inbox size={13} />}
              {test.folderName ?? "Unfiled"}
            </span>
            {test.tags.map((tag) => (
              <span key={tag} className={styles.tag}>
                {tag}
              </span>
            ))}
          </div>
        </div>
        <span className={styles.created}>{shortDate(test.createdAt)}</span>
        <Button variant="secondary" size="sm" iconLeft={<Play size={13} />} onClick={() => onRun(test.id)}>
          Run
        </Button>
        <IconButton
          variant="ghost"
          size="sm"
          icon={<MoreHorizontal />}
          label={`Organize ${test.name}`}
          onClick={() => setOrganizing((o) => !o)}
        />
      </div>
      {organizing && (
        <OrganizeEditor test={test} folders={folders} allTags={allTags} onDone={() => setOrganizing(false)} />
      )}
    </div>
  );
}

/**
 * Inline organize editor: rename, (un)file, and edit tags in one save. Pure
 * organization metadata — the server writes only organization rows (no new test
 * version), so this never touches baselines or review state.
 */
function OrganizeEditor({
  test,
  folders,
  allTags,
  onDone,
}: {
  test: TestSummary;
  folders: FolderSummary[];
  allTags: string[];
  onDone: () => void;
}) {
  const update = useUpdateTest();
  const { toast } = useToast();
  const [name, setName] = useState(test.name);
  const [folderId, setFolderId] = useState(test.folderId ?? "");
  const [tags, setTags] = useState<string[]>(test.tags);
  const [tagInput, setTagInput] = useState("");

  function addTag() {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags((ts) => [...ts, t]);
    setTagInput("");
  }

  function save() {
    const pending = tagInput.trim();
    const finalTags = pending && !tags.includes(pending) ? [...tags, pending] : tags;
    update.mutate(
      { id: test.id, body: { name: name.trim() || test.name, folderId: folderId || null, tags: finalTags } },
      {
        onSuccess: () => {
          toast(`Saved “${name.trim() || test.name}”`);
          onDone();
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Save failed"),
      },
    );
  }

  return (
    <div className={styles.editor}>
      <div className={styles.editorTop}>
        <Input aria-label="Test name" inputSize="sm" value={name} onChange={(e) => setName(e.target.value)} />
        <Select
          ariaLabel="Folder"
          selectSize="sm"
          value={folderId}
          onValueChange={setFolderId}
          options={[{ value: "", label: "— Unfiled —" }, ...folders.map((f) => ({ value: f.id, label: f.name }))]}
        />
      </div>
      <div className={styles.tagEditor}>
        {tags.map((tag) => (
          <span key={tag} className={styles.editTag}>
            {tag}
            <button type="button" className={styles.tagRemove} aria-label={`Remove ${tag}`} onClick={() => setTags((ts) => ts.filter((x) => x !== tag))}>
              ×
            </button>
          </span>
        ))}
        <input
          aria-label="Add tag"
          className={styles.tagInput}
          placeholder="Add tag…"
          list={`tags-${test.id}`}
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
        />
        <datalist id={`tags-${test.id}`}>
          {allTags.filter((t) => !tags.includes(t)).map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>
      <div className={styles.editorActions}>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" loading={update.isPending} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
