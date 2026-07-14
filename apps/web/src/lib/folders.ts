import type { FolderSummary } from "@varys/review-contract";

/** A folder's full path label — "Parent / Child / Leaf" — walking parent links, so nested
 *  folders (and duplicate sibling names under different parents) are unambiguous in a picker.
 *  Bounded by the folder count so a broken/cyclic chain can't loop forever. */
export function folderPathLabel(folder: FolderSummary, byId: Map<string, FolderSummary>): string {
  const parts: string[] = [];
  let cur: FolderSummary | undefined = folder;
  for (let i = 0; cur && i <= byId.size; i++) {
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(" / ");
}

/** `<Select>` options for filing into a folder, each labelled by its full path and sorted by it. */
export function folderPathOptions(folders: FolderSummary[]): { value: string; label: string }[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  return folders
    .map((f) => ({ value: f.id, label: folderPathLabel(f, byId) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
