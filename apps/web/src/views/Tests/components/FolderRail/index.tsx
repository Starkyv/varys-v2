import type { FolderSummary } from "@varys/review-contract";
import { ChevronRight, cx, Flask, Folder, Inbox, Plus, Trash } from "@varys/ui";
import { type DragEvent, useMemo, useState } from "react";
import { useConfirm } from "../../../../context/confirm";
import { useToast } from "../../../../context/toast";
import { useCreateFolder, useDeleteFolder, useMoveFolder, useRenameFolder } from "../../../../queries";
import styles from "./styles.module.scss";

export type FolderFilter = "__all" | "__unfiled" | string;

interface RailCounts {
  all: number;
  unfiled: number;
  /** Subtree test count per folder (folder + all descendants). */
  byId: Record<string, number>;
}

/**
 * Finder-style folder navigator: a breadcrumb path + the current level's subfolders. Clicking a
 * folder GOES INSIDE it (breadcrumb extends, the sidebar shows its subfolders, the test list shows
 * its tests). Any breadcrumb crumb jumps back up. Folders can be created at the current level,
 * renamed (double-click), deleted, and drag-reparented; tests drag onto a folder (or a crumb) to
 * file them. The "current location" is derived from the active selection, so it survives refetch.
 */
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
  const moveFolder = useMoveFolder();

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, FolderSummary[]>();
    for (const f of folders) {
      const p = f.parentId ?? null;
      m.set(p, [...(m.get(p) ?? []), f]);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [folders]);

  // The folder we're browsing INSIDE (null = top level), derived from the active selection so the
  // navigator location is stable across refetches without a second source of truth.
  const location = active === "__all" || active === "__unfiled" || !byId.has(active) ? null : active;

  // Breadcrumb path: root → ancestors → current folder.
  const crumbs = useMemo(() => {
    const path: FolderSummary[] = [];
    let cur = location ? byId.get(location) : undefined;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path;
  }, [location, byId]);

  const level = childrenOf.get(location) ?? [];

  const [over, setOver] = useState<string | null>(null);
  const [dragFolder, setDragFolder] = useState<FolderSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  /** Every id at or under `rootId` — a reparent must not drop into this set (would make a cycle). */
  function subtreeIds(rootId: string): Set<string> {
    const out = new Set<string>();
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (out.has(id)) continue;
      out.add(id);
      for (const c of childrenOf.get(id) ?? []) stack.push(c.id);
    }
    return out;
  }

  function createHere() {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    createFolder.mutate(
      { name, parentId: location ?? undefined },
      {
        onSuccess: () => {
          toast(`Folder “${name}” created`);
          setNewName("");
          setCreating(false);
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t create folder"),
      },
    );
  }

  function commitRename(id: string, currentName: string) {
    const name = renameValue.trim();
    if (name && name !== currentName) {
      renameFolder.mutate(
        { id, name },
        { onError: (e) => toast(e instanceof Error ? e.message : "Rename failed") },
      );
    }
    setRenamingId(null);
  }

  async function onDelete(f: FolderSummary) {
    const subs = subtreeIds(f.id).size - 1;
    const message = subs
      ? `This folder and its ${subs} subfolder${subs === 1 ? "" : "s"} are removed; their tests become Unfiled — the tests are not deleted.`
      : "Its tests become Unfiled — they are not deleted.";
    const ok = await confirm({
      title: `Delete folder “${f.name}”?`,
      message,
      confirmLabel: "Delete folder",
      tone: "danger",
    });
    if (!ok) return;
    deleteFolder.mutate(f.id, {
      onSuccess: () => {
        toast(`Folder “${f.name}” deleted`);
        // If we were viewing the deleted folder (or a descendant), step up to its parent.
        if (active === f.id || (byId.has(active) && subtreeIds(f.id).has(active))) {
          onSelect(f.parentId ?? "__all");
        }
      },
    });
  }

  /** Can the dragged folder be dropped onto `targetId` (null = root)? Not itself, not a descendant,
   *  and not a no-op move to its current parent. */
  function canDropFolder(targetId: string | null): boolean {
    if (!dragFolder) return false;
    if (targetId === dragFolder.id) return false;
    if (targetId !== null && subtreeIds(dragFolder.id).has(targetId)) return false;
    return (dragFolder.parentId ?? null) !== (targetId ?? null);
  }

  function onTargetDragOver(e: DragEvent, dropId: string, folderTarget: string | null, acceptsTest: boolean) {
    if (dragFolder) {
      if (!canDropFolder(folderTarget)) return;
    } else if (!(dragActive && acceptsTest)) {
      return;
    }
    e.preventDefault();
    if (over !== dropId) setOver(dropId);
  }

  function onTargetDrop(e: DragEvent, folderTarget: string | null, acceptsTest: boolean) {
    e.preventDefault();
    setOver(null);
    if (dragFolder) {
      if (canDropFolder(folderTarget)) {
        moveFolder.mutate(
          { id: dragFolder.id, parentId: folderTarget },
          { onError: (err) => toast(err instanceof Error ? err.message : "Couldn’t move folder") },
        );
      }
      setDragFolder(null);
    } else if (dragActive && acceptsTest) {
      onDropToFolder(folderTarget);
    }
  }

  return (
    <div className={styles.rail}>
      <div className={styles.title}>Folders</div>

      {/* Breadcrumb — the path you're in; every crumb jumps there, and accepts a dropped test/folder. */}
      <nav className={styles.crumbs} aria-label="Folder path">
        <button
          type="button"
          className={cx(styles.crumb, active === "__all" && styles.crumbActive, over === "__all" && styles.dropOver)}
          onClick={() => onSelect("__all")}
          onDragOver={(e) => onTargetDragOver(e, "__all", null, true)}
          onDragLeave={() => setOver((o) => (o === "__all" ? null : o))}
          onDrop={(e) => onTargetDrop(e, null, true)}
        >
          <Flask size={14} />
          All tests
          <span className={styles.crumbCount}>{counts.all}</span>
        </button>
        {crumbs.map((c) => (
          <span key={c.id} className={styles.crumbWrap}>
            <ChevronRight size={13} className={styles.crumbSep} />
            <button
              type="button"
              className={cx(styles.crumb, active === c.id && styles.crumbActive, over === `crumb-${c.id}` && styles.dropOver)}
              onClick={() => onSelect(c.id)}
              onDragOver={(e) => onTargetDragOver(e, `crumb-${c.id}`, c.id, true)}
              onDragLeave={() => setOver((o) => (o === `crumb-${c.id}` ? null : o))}
              onDrop={(e) => onTargetDrop(e, c.id, true)}
            >
              {c.name}
            </button>
          </span>
        ))}
      </nav>

      {/* Current level — the subfolders you can open. */}
      <div className={styles.items}>
        {level.map((f) => {
          const isActive = active === f.id;
          const isOver = over === f.id;
          const count = counts.byId[f.id] ?? 0;
          const hasChildren = (childrenOf.get(f.id)?.length ?? 0) > 0;
          return (
            <div
              key={f.id}
              className={cx(styles.item, isActive && styles.active, isOver && styles.dropOver)}
              draggable={renamingId !== f.id}
              onDragStart={(e) => {
                setDragFolder(f);
                e.dataTransfer.setData("text/plain", f.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragFolder(null);
                setOver(null);
              }}
              onDragOver={(e) => onTargetDragOver(e, f.id, f.id, true)}
              onDragLeave={() => setOver((o) => (o === f.id ? null : o))}
              onDrop={(e) => onTargetDrop(e, f.id, true)}
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
                  onBlur={() => commitRename(f.id, f.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(f.id, f.name);
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
                  title="Open · double-click to rename"
                >
                  {f.name}
                </button>
              )}
              {renamingId !== f.id && (
                <>
                  <button
                    type="button"
                    className={styles.rowAction}
                    aria-label={`Delete ${f.name}`}
                    onClick={() => void onDelete(f)}
                  >
                    <Trash size={14} />
                  </button>
                  <span className={styles.count}>{count}</span>
                  <span className={cx(styles.enter, !hasChildren && styles.enterMuted)} aria-hidden>
                    <ChevronRight size={15} />
                  </span>
                </>
              )}
            </div>
          );
        })}

        {/* Unfiled bucket lives at the top level only. */}
        {location === null && (
          <div
            className={cx(styles.item, active === "__unfiled" && styles.active, over === "__unfiled" && styles.dropOver)}
            onDragOver={(e) => onTargetDragOver(e, "__unfiled", null, true)}
            onDragLeave={() => setOver((o) => (o === "__unfiled" ? null : o))}
            onDrop={(e) => onTargetDrop(e, null, true)}
          >
            <span className={styles.icon}>
              <Inbox size={17} />
            </span>
            <button type="button" className={styles.nameBtn} onClick={() => onSelect("__unfiled")}>
              Unfiled
            </button>
            <span className={styles.count}>{counts.unfiled}</span>
          </div>
        )}

        {level.length === 0 && location !== null && (
          <div className={styles.levelEmpty}>No subfolders here — this folder’s tests are on the right.</div>
        )}
      </div>

      {creating ? (
        <input
          autoFocus
          className={styles.newInput}
          placeholder={location ? "Subfolder name" : "Folder name"}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onBlur={createHere}
          onKeyDown={(e) => {
            if (e.key === "Enter") createHere();
            if (e.key === "Escape") {
              setNewName("");
              setCreating(false);
            }
          }}
        />
      ) : (
        <button type="button" className={styles.newFolder} onClick={() => setCreating(true)}>
          <Plus size={14} />
          {location ? `New folder in “${byId.get(location)?.name ?? ""}”` : "New folder"}
        </button>
      )}

      <div className={styles.hint}>Click a folder to open it. Drag a test onto a folder to file it.</div>
    </div>
  );
}
