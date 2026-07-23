import type { FolderSummary } from "@varys/review-contract";
import { ChevronRight, cx, Flask, Folder, Inbox, Pencil, Plus, Trash } from "@varys/ui";
import { type DragEvent, useEffect, useMemo, useState } from "react";
import { useConfirm } from "../../../../context/confirm";
import { useToast } from "../../../../context/toast";
import { useCreateFolder, useDeleteFolder, useMoveFolder, useRenameFolder } from "../../../../queries";
import styles from "./styles.module.scss";

export type FolderFilter = "__all" | "__unfiled" | string;

const EXPANDED_KEY = "varys.folderTree.expanded";

/** One rendered tree row: the folder, its depth (for indentation), and whether it has children. */
interface Row {
  folder: FolderSummary;
  depth: number;
  hasChildren: boolean;
}

/**
 * Finder-style folder tree: the whole hierarchy at once, with disclosure triangles + indentation.
 * Click a folder to select it (its tests show on the right); click the triangle to expand/collapse.
 * Hover a row for its actions — new subfolder, rename, delete. Drag a test onto a folder to file it;
 * drag a folder onto another to reparent it (cycles blocked). Counts are per-folder DIRECT test
 * counts (a folder's subfolders appear as their own rows), so the badge and the list always agree.
 */
export function FolderRail({
  folders,
  allCount,
  unfiledCount,
  active,
  onSelect,
  dragActive,
  onDropToFolder,
}: {
  folders: FolderSummary[];
  allCount: number;
  unfiledCount: number;
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

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });
  function persistExpanded(next: Set<string>) {
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore quota / private-mode errors */
    }
  }
  function toggle(id: string) {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    persistExpanded(next);
  }

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

  // Reveal the selected folder by expanding its ancestors — but ONLY when the selection actually
  // changes (keyed on `active` alone, NOT on data refetches), so collapsing a parent by hand isn't
  // undone the next time the folders query refreshes.
  useEffect(() => {
    if (active === "__all" || active === "__unfiled" || !byId.has(active)) return;
    const toOpen: string[] = [];
    let cur = byId.get(active)?.parentId ?? null;
    while (cur) {
      toOpen.push(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    if (toOpen.length && toOpen.some((id) => !expanded.has(id))) {
      persistExpanded(new Set([...expanded, ...toOpen]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Flatten the tree to the visible rows (a node's children only when it's expanded).
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const f of childrenOf.get(parent) ?? []) {
        const kids = childrenOf.get(f.id) ?? [];
        out.push({ folder: f, depth, hasChildren: kids.length > 0 });
        if (kids.length > 0 && expanded.has(f.id)) walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [childrenOf, expanded]);

  const [over, setOver] = useState<string | null>(null);
  const [dragFolder, setDragFolder] = useState<FolderSummary | null>(null);
  const [creatingParent, setCreatingParent] = useState<string | null | undefined>(undefined);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  function beginCreate(parentId: string | null) {
    setCreatingParent(parentId);
    setNewName("");
    if (parentId) persistExpanded(new Set([...expanded, parentId]));
  }
  function createNow() {
    const name = newName.trim();
    const parentId = creatingParent;
    if (!name || parentId === undefined) {
      setCreatingParent(undefined);
      return;
    }
    createFolder.mutate(
      { name, parentId: parentId ?? undefined },
      {
        onSuccess: () => {
          toast(`Folder “${name}” created`);
          setNewName("");
          setCreatingParent(undefined);
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
        if (active === f.id || (byId.has(active) && subtreeIds(f.id).has(active))) {
          onSelect(f.parentId ?? "__all");
        }
      },
    });
  }

  /** Can the dragged folder drop onto `targetId` (null = root)? Not itself, not into its own
   *  subtree, and not a no-op move to its current parent. */
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
      <div className={styles.head}>
        <span className={styles.title}>Folders</span>
        <button
          type="button"
          className={styles.newRoot}
          onClick={() => beginCreate(null)}
          title="New top-level folder"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className={styles.tree}>
        {/* All tests — the root selection + a drop target that unfiles. */}
        <button
          type="button"
          className={cx(
            styles.row,
            styles.special,
            active === "__all" && styles.active,
            over === "__all" && styles.dropOver,
          )}
          onClick={() => onSelect("__all")}
          onDragOver={(e) => onTargetDragOver(e, "__all", null, true)}
          onDragLeave={() => setOver((o) => (o === "__all" ? null : o))}
          onDrop={(e) => onTargetDrop(e, null, true)}
        >
          <span className={styles.disc} />
          <Flask size={16} className={styles.folderIcon} />
          <span className={styles.name}>All tests</span>
          <span className={styles.count}>{allCount}</span>
        </button>

        {rows.map(({ folder: f, depth, hasChildren }) => {
          const isActive = active === f.id;
          const isOver = over === f.id;
          const isRenaming = renamingId === f.id;
          const isExpanded = expanded.has(f.id);
          return (
            <div
              key={f.id}
              className={cx(styles.row, isActive && styles.active, isOver && styles.dropOver)}
              style={{ paddingLeft: `${8 + depth * 16}px` }}
              draggable={!isRenaming}
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
              {hasChildren ? (
                <button
                  type="button"
                  className={cx(styles.disc, styles.discBtn, isExpanded && styles.discOpen)}
                  aria-label={isExpanded ? "Collapse" : "Expand"}
                  onClick={() => toggle(f.id)}
                >
                  <ChevronRight size={13} />
                </button>
              ) : (
                <span className={styles.disc} />
              )}
              <Folder size={16} className={styles.folderIcon} />
              {isRenaming ? (
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
                  className={styles.name}
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
              {!isRenaming && (
                <>
                  <span className={styles.actions}>
                    <button
                      type="button"
                      className={styles.action}
                      aria-label={`New subfolder in ${f.name}`}
                      title="New subfolder"
                      onClick={() => beginCreate(f.id)}
                    >
                      <Plus size={13} />
                    </button>
                    <button
                      type="button"
                      className={styles.action}
                      aria-label={`Rename ${f.name}`}
                      title="Rename"
                      onClick={() => {
                        setRenamingId(f.id);
                        setRenameValue(f.name);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className={styles.action}
                      aria-label={`Delete ${f.name}`}
                      title="Delete"
                      onClick={() => void onDelete(f)}
                    >
                      <Trash size={13} />
                    </button>
                  </span>
                  {f.testCount > 0 && <span className={styles.count}>{f.testCount}</span>}
                </>
              )}
            </div>
          );
        })}

        {/* The create-folder input, anchored to the bottom, labelled with its target parent. */}
        {creatingParent !== undefined && (
          <input
            autoFocus
            className={styles.newInput}
            placeholder={creatingParent ? `New folder in “${byId.get(creatingParent)?.name ?? ""}”` : "New folder name"}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={createNow}
            onKeyDown={(e) => {
              if (e.key === "Enter") createNow();
              if (e.key === "Escape") setCreatingParent(undefined);
            }}
          />
        )}

        {/* Unfiled — tests with no folder. */}
        <button
          type="button"
          className={cx(
            styles.row,
            styles.special,
            active === "__unfiled" && styles.active,
            over === "__unfiled" && styles.dropOver,
          )}
          onClick={() => onSelect("__unfiled")}
          onDragOver={(e) => onTargetDragOver(e, "__unfiled", null, true)}
          onDragLeave={() => setOver((o) => (o === "__unfiled" ? null : o))}
          onDrop={(e) => onTargetDrop(e, null, true)}
        >
          <span className={styles.disc} />
          <Inbox size={16} className={styles.folderIcon} />
          <span className={styles.name}>Unfiled</span>
          {unfiledCount > 0 && <span className={styles.count}>{unfiledCount}</span>}
        </button>
      </div>

      <div className={styles.hint}>Drag a test onto a folder to file it · drag a folder to move it.</div>
    </div>
  );
}
