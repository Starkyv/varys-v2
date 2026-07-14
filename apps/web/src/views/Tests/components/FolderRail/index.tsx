import type { FolderSummary } from "@varys/review-contract";
import { ChevronDown, ChevronRight, cx, Flask, Folder, Inbox, Plus, Trash } from "@varys/ui";
import { type DragEvent, useMemo, useState } from "react";
import { useConfirm } from "../../../../context/confirm";
import { useToast } from "../../../../context/toast";
import { useCreateFolder, useDeleteFolder, useMoveFolder, useRenameFolder } from "../../../../queries";
import styles from "./styles.module.scss";

export type FolderFilter = "__all" | "__unfiled" | string;

interface RailCounts {
  all: number;
  unfiled: number;
  byId: Record<string, number>;
}

type FolderNode = FolderSummary & { children: FolderNode[] };

/** Assemble the flat folder list into a parent→children tree (roots = no/absent parent). */
function buildTree(folders: FolderSummary[]): FolderNode[] {
  const byId = new Map<string, FolderNode>(folders.map((f) => [f.id, { ...f, children: [] }]));
  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Every id at or under `node` — the set a reparent must not drop into (would make a cycle). */
function subtreeIds(node: FolderNode, acc: Set<string> = new Set()): Set<string> {
  acc.add(node.id);
  for (const c of node.children) subtreeIds(c, acc);
  return acc;
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
  const moveFolder = useMoveFolder();

  const tree = useMemo(() => buildTree(folders), [folders]);

  const [over, setOver] = useState<string | null>(null);
  const [creatingRoot, setCreatingRoot] = useState(false);
  const [newName, setNewName] = useState("");
  const [subUnder, setSubUnder] = useState<string | null>(null); // create a subfolder under this id
  const [subName, setSubName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Folders are open by default; we track which are explicitly COLLAPSED so newly-loaded /
  // created folders start expanded (their nesting is visible without a click).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragFolder, setDragFolder] = useState<FolderNode | null>(null);

  const isOpen = (id: string) => !collapsed.has(id);
  const toggleOpen = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openFolder = (id: string) =>
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  function commitCreateRoot() {
    const name = newName.trim();
    if (!name) {
      setCreatingRoot(false);
      return;
    }
    createFolder.mutate(
      { name },
      {
        onSuccess: () => {
          toast(`Folder “${name}” created`);
          setNewName("");
          setCreatingRoot(false);
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t create folder"),
      },
    );
  }

  function commitCreateSub(parentId: string) {
    const name = subName.trim();
    if (!name) {
      setSubUnder(null);
      return;
    }
    createFolder.mutate(
      { name, parentId },
      {
        onSuccess: () => {
          toast(`Subfolder “${name}” created`);
          setSubName("");
          setSubUnder(null);
          openFolder(parentId);
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t create subfolder"),
      },
    );
  }

  function commitRename(id: string, currentName: string) {
    const name = renameValue.trim();
    if (name && name !== currentName) {
      renameFolder.mutate({ id, name }, { onError: (e) => toast(e instanceof Error ? e.message : "Rename failed") });
    }
    setRenamingId(null);
  }

  async function onDelete(node: FolderNode) {
    const subs = subtreeIds(node).size - 1; // descendant folders (excluding this one)
    const message = subs
      ? `This folder and its ${subs} subfolder${subs === 1 ? "" : "s"} are removed; their tests become Unfiled — the tests are not deleted.`
      : "Its tests become Unfiled — they are not deleted.";
    const ok = await confirm({
      title: `Delete folder “${node.name}”?`,
      message,
      confirmLabel: "Delete folder",
      tone: "danger",
    });
    if (!ok) return;
    deleteFolder.mutate(node.id, {
      onSuccess: () => {
        toast(`Folder “${node.name}” deleted`);
        if (active === node.id) onSelect("__all");
      },
    });
  }

  /** Can the dragged folder be dropped onto `targetId` (null = root)? Not itself, not one of
   *  its own descendants, and not a no-op move to its current parent. */
  function canDropFolder(targetId: string | null): boolean {
    if (!dragFolder) return false;
    if (targetId === dragFolder.id) return false;
    if (targetId !== null && subtreeIds(dragFolder).has(targetId)) return false;
    return (dragFolder.parentId ?? null) !== (targetId ?? null);
  }

  /** Drag-over a drop target: allow a folder reparent (when legal) or a test file. */
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

  function renderNode(node: FolderNode, depth: number) {
    const isActive = active === node.id;
    const isOver = over === node.id;
    const hasChildren = node.children.length > 0;
    const count = counts.byId[node.id] ?? 0;
    return (
      <div key={node.id}>
        <div
          className={cx(styles.item, isActive && styles.active, isOver && styles.dropOver)}
          style={{ paddingLeft: `calc(var(--space-12) + ${depth * 16}px)` }}
          draggable={renamingId !== node.id}
          onDragStart={(e) => {
            setDragFolder(node);
            e.dataTransfer.setData("text/plain", node.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            setDragFolder(null);
            setOver(null);
          }}
          onDragOver={(e) => onTargetDragOver(e, node.id, node.id, true)}
          onDragLeave={() => setOver((o) => (o === node.id ? null : o))}
          onDrop={(e) => onTargetDrop(e, node.id, true)}
        >
          {hasChildren ? (
            <button
              type="button"
              className={styles.chevron}
              aria-label={isOpen(node.id) ? "Collapse" : "Expand"}
              aria-expanded={isOpen(node.id)}
              onClick={() => toggleOpen(node.id)}
            >
              {isOpen(node.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <span className={styles.chevronSpacer} />
          )}
          <span className={styles.icon}>
            <Folder size={17} />
          </span>
          {renamingId === node.id ? (
            <input
              autoFocus
              className={styles.renameInput}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => commitRename(node.id, node.name)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(node.id, node.name);
                if (e.key === "Escape") setRenamingId(null);
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.nameBtn}
              onClick={() => onSelect(node.id)}
              onDoubleClick={() => {
                setRenamingId(node.id);
                setRenameValue(node.name);
              }}
              title="Double-click to rename"
            >
              {node.name}
            </button>
          )}
          {renamingId !== node.id && (
            <>
              <button
                type="button"
                className={styles.addSub}
                aria-label={`Add subfolder in ${node.name}`}
                title="New subfolder"
                onClick={() => {
                  openFolder(node.id);
                  setSubUnder(node.id);
                  setSubName("");
                }}
              >
                <Plus size={13} />
              </button>
              <button
                type="button"
                className={styles.rowAction}
                aria-label={`Delete ${node.name}`}
                onClick={() => void onDelete(node)}
              >
                <Trash size={14} />
              </button>
              <span className={styles.count}>{count}</span>
            </>
          )}
        </div>

        {subUnder === node.id && (
          <input
            autoFocus
            className={styles.subInput}
            style={{ marginLeft: `${(depth + 1) * 16}px` }}
            placeholder="Subfolder name"
            value={subName}
            onChange={(e) => setSubName(e.target.value)}
            onBlur={() => commitCreateSub(node.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCreateSub(node.id);
              if (e.key === "Escape") {
                setSubName("");
                setSubUnder(null);
              }
            }}
          />
        )}

        {hasChildren && isOpen(node.id) && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  return (
    <div className={styles.rail}>
      <div className={styles.title}>Folders</div>
      <div className={styles.items}>
        <button
          type="button"
          className={cx(styles.item, active === "__all" && styles.active, over === "__all" && styles.dropOver)}
          onClick={() => onSelect("__all")}
          onDragOver={(e) => onTargetDragOver(e, "__all", null, false)}
          onDragLeave={() => setOver((o) => (o === "__all" ? null : o))}
          onDrop={(e) => onTargetDrop(e, null, false)}
        >
          <span className={styles.chevronSpacer} />
          <span className={styles.icon}>
            <Flask size={17} />
          </span>
          <span className={styles.name}>All tests</span>
          <span className={styles.count}>{counts.all}</span>
        </button>

        {tree.map((node) => renderNode(node, 0))}

        <div
          className={cx(styles.item, active === "__unfiled" && styles.active, over === "__unfiled" && styles.dropOver)}
          onDragOver={(e) => onTargetDragOver(e, "__unfiled", null, true)}
          onDragLeave={() => setOver((o) => (o === "__unfiled" ? null : o))}
          onDrop={(e) => onTargetDrop(e, null, true)}
        >
          <span className={styles.chevronSpacer} />
          <span className={styles.icon}>
            <Inbox size={17} />
          </span>
          <button type="button" className={styles.nameBtn} onClick={() => onSelect("__unfiled")}>
            Unfiled
          </button>
          <span className={styles.count}>{counts.unfiled}</span>
        </div>
      </div>

      {creatingRoot ? (
        <input
          autoFocus
          className={styles.newInput}
          placeholder="Folder name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onBlur={commitCreateRoot}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitCreateRoot();
            if (e.key === "Escape") {
              setNewName("");
              setCreatingRoot(false);
            }
          }}
        />
      ) : (
        <button type="button" className={styles.newFolder} onClick={() => setCreatingRoot(true)}>
          <Plus size={14} />
          New folder
        </button>
      )}

      <div className={styles.hint}>Drag a test onto a folder to file it, or drag a folder onto another to nest it.</div>
    </div>
  );
}
