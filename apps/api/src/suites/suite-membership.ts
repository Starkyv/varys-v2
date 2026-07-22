import { folders, suiteFolders, suiteTests, tests } from "@varys/db";
import { eq } from "drizzle-orm";
import type { Db } from "../db/db.module";

/**
 * Suite membership resolution — shared by SuitesService (read models) and SuiteRunsService
 * (fan-out). A suite selects any mix of whole FOLDERS and individual STANDALONE tests. Folders
 * resolve DYNAMICALLY: a folder includes all tests in it AND its subfolders, computed at read/run
 * time, so a test filed into a selected folder later is picked up automatically. Kept as pure
 * functions (not a provider) so both modules can use it without a circular dependency.
 */

/** A suite's RAW selection: the folder ids and standalone test ids it was saved with. */
export async function suiteSelection(
  db: Db,
  suiteId: string,
): Promise<{ testIds: string[]; folderIds: string[] }> {
  const [tRows, fRows] = await Promise.all([
    db.select({ testId: suiteTests.testId }).from(suiteTests).where(eq(suiteTests.suiteId, suiteId)),
    db
      .select({ folderId: suiteFolders.folderId })
      .from(suiteFolders)
      .where(eq(suiteFolders.suiteId, suiteId)),
  ]);
  return { testIds: tRows.map((r) => r.testId), folderIds: fRows.map((r) => r.folderId) };
}

/** parent-folder-id → child-folder-ids, for subtree expansion. */
export async function folderChildren(db: Db): Promise<Map<string, string[]>> {
  const all = await db.select({ id: folders.id, parentId: folders.parentId }).from(folders);
  const children = new Map<string, string[]>();
  for (const f of all) {
    if (!f.parentId) continue;
    const arr = children.get(f.parentId) ?? [];
    arr.push(f.id);
    children.set(f.parentId, arr);
  }
  return children;
}

/** All descendant folder ids (inclusive) of the given roots. */
export function subtreeOf(rootIds: string[], children: Map<string, string[]>): Set<string> {
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

/**
 * The effective, deduped set of ACTIVE test ids a suite selects: every active test whose folder is
 * in a selected folder's subtree, unioned with the individually-selected tests. Used by the run
 * fan-out (resolves folders at trigger time).
 */
export async function effectiveTestIds(db: Db, suiteId: string): Promise<string[]> {
  const { testIds, folderIds } = await suiteSelection(db, suiteId);
  const ids = new Set(testIds);
  if (folderIds.length > 0) {
    const subtree = subtreeOf(folderIds, await folderChildren(db));
    const rows = await db
      .select({ id: tests.id, folderId: tests.folderId, status: tests.status })
      .from(tests);
    for (const t of rows) {
      if (t.status === "active" && t.folderId && subtree.has(t.folderId)) ids.add(t.id);
    }
  }
  return [...ids];
}
