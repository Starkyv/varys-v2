import type { FolderSummary } from "@varys/review-contract";
import { cx, Flask, Folder, Inbox, Plus, Trash } from "@varys/ui";
import { type DragEvent, useState } from "react";
import { useConfirm } from "../../../../context/confirm";
import { useToast } from "../../../../context/toast";
import { useCreateFolder, useDeleteFolder, useRenameFolder } from "../../../../queries";
import styles from "./styles.module.scss";

export type FolderFilter = "__all" | "__unfiled" | string;

interface RailCounts {
  all: number;
  unfiled: number;
  byId: Record<string, number>;
}

export function FolderRail({
  folders,
  counts,
  active,
  onSelect,
  dragActive,
  onDropToFolder,
}: {
  folders: FolderSummary[];
  counts: RailCounts;
  active: FolderFilter;
  onSelect: (filter: FolderFilter) => void;
  dragActive: boolean;
  /** folderId, or null to unfile. */
  onDropToFolder: (folderId: string | null) => void;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const createFolder = useCreateFolder();
  const renameFolder = useRenameFolder();
  const deleteFolder = useDeleteFolder();

  const [over, setOver] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  function commitCreate() {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    createFolder.mutate(name, {
      onSuccess: () => {
        toast(`Folder “${name}” created`);
        setNewName("");
        setCreating(false);
      },
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t create folder"),
    });
  }

  function commitRename(id: string) {
    const name = renameValue.trim();
    const current = folders.find((f) => f.id === id);
    if (name && current && name !== current.name) {
      renameFolder.mutate({ id, name }, { onError: (e) => toast(e instanceof Error ? e.message : "Rename failed") });
    }
    setRenamingId(null);
  }

  async function onDelete(f: FolderSummary) {
    const ok = await confirm({
      title: `Delete folder “${f.name}”?`,
      message: `Its ${f.testCount} test${f.testCount === 1 ? "" : "s"} become Unfiled — they are not deleted.`,
      confirmLabel: "Delete folder",
      tone: "danger",
    });
    if (!ok) return;
    deleteFolder.mutate(f.id, {
      onSuccess: () => {
        toast(`Folder “${f.name}” deleted`);
        if (active === f.id) onSelect("__all");
      },
    });
  }

  // A drop target row: handles the drag-over outline + drop.
  function dropProps(dropId: string, folderId: string | null) {
    if (!dragActive) return {};
    return {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        if (over !== dropId) setOver(dropId);
      },
      onDragLeave: () => setOver((o) => (o === dropId ? null : o)),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(null);
        onDropToFolder(folderId);
      },
    };
  }

  return (
    <div className={styles.rail}>
      <div className={styles.title}>Folders</div>
      <div className={styles.items}>
        <button
          type="button"
          className={cx(styles.item, active === "__all" && styles.active)}
          onClick={() => onSelect("__all")}
        >
          <span className={styles.icon}>
            <Flask size={17} />
          </span>
          <span className={styles.name}>All tests</span>
          <span className={styles.count}>{counts.all}</span>
        </button>

        {folders.map((f) => {
          const isOver = over === f.id;
          const isActive = active === f.id;
          return (
            <div
              key={f.id}
              className={cx(styles.item, isActive && styles.active, isOver && styles.dropOver)}
              {...dropProps(f.id, f.id)}
            >
              <span className={styles.icon}>
                <Folder size={17} />
              </span>
              {renamingId === f.id ? (
                <input
                  autoFocus
                  className={styles.renameInput}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(f.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(f.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={styles.nameBtn}
                  onClick={() => onSelect(f.id)}
                  onDoubleClick={() => {
                    setRenamingId(f.id);
                    setRenameValue(f.name);
                  }}
                  title="Double-click to rename"
                >
                  {f.name}
                </button>
              )}
              {renamingId !== f.id && (
                <>
                  <button type="button" className={styles.rowAction} aria-label={`Delete ${f.name}`} onClick={() => void onDelete(f)}>
                    <Trash size={14} />
                  </button>
                  <span className={styles.count}>{counts.byId[f.id] ?? 0}</span>
                </>
              )}
            </div>
          );
        })}

        <div
          className={cx(styles.item, active === "__unfiled" && styles.active, over === "__unfiled" && styles.dropOver)}
          {...dropProps("__unfiled", null)}
        >
          <span className={styles.icon}>
            <Inbox size={17} />
          </span>
          <button type="button" className={styles.nameBtn} onClick={() => onSelect("__unfiled")}>
            Unfiled
          </button>
          <span className={styles.count}>{counts.unfiled}</span>
        </div>
      </div>

      {creating ? (
        <input
          autoFocus
          className={styles.newInput}
          placeholder="Folder name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onBlur={commitCreate}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitCreate();
            if (e.key === "Escape") {
              setNewName("");
              setCreating(false);
            }
          }}
        />
      ) : (
        <button type="button" className={styles.newFolder} onClick={() => setCreating(true)}>
          <Plus size={14} />
          New folder
        </button>
      )}

      <div className={styles.hint}>Drag a test onto a folder to file it.</div>
    </div>
  );
}
