import type { FolderSummary } from "@varys/review-contract";
import {
  Button,
  ChevronRight,
  EmptyState,
  ErrorState,
  ExternalLink,
  Flask,
  Folder,
  Search,
  Skeleton,
} from "@varys/ui";
import { useMemo, useState } from "react";
import { useRunDialog } from "../../context/run-dialog";
import { useToast } from "../../context/toast";
import { useFolders, useTags, useTests, useUpdateTest } from "../../queries";
import { type FolderFilter, FolderRail } from "./components/FolderRail";
import { TagFilter } from "./components/TagFilter";
import { TestRow } from "./components/TestRow";
import styles from "./styles.module.scss";

export function Tests() {
  const tests = useTests();
  const folders = useFolders();
  const tags = useTags();
  const update = useUpdateTest();
  const { openRunDialog } = useRunDialog();
  const { toast } = useToast();

  const [folderFilter, setFolderFilter] = useState<FolderFilter>("__all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const all = tests.data ?? [];

  // The tree shows per-folder DIRECT counts (each folder.testCount from the API); we only need the
  // two totals here. "Unfiled" = tests with no folder.
  const unfiledCount = useMemo(() => all.filter((t) => t.folderId == null).length, [all]);

  const foldersData = folders.data ?? [];
  const byId = useMemo(() => new Map(foldersData.map((f) => [f.id, f])), [foldersData]);
  const selectedFolder =
    folderFilter !== "__all" && folderFilter !== "__unfiled" ? byId.get(folderFilter) : undefined;

  // Subfolders to show as tiles in the main pane, so you can drill DOWN from the right too (root
  // folders when viewing "All tests"; none for Unfiled).
  const childFolders = useMemo(() => {
    if (folderFilter === "__unfiled") return [];
    const parentId = folderFilter === "__all" ? null : (selectedFolder?.id ?? null);
    return foldersData
      .filter((f) => (f.parentId ?? null) === parentId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [foldersData, folderFilter, selectedFolder]);

  // Path root → selected, for the content-pane breadcrumb (each crumb navigates UP).
  const crumbs = useMemo(() => {
    const path: FolderSummary[] = [];
    let cur = selectedFolder;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path;
  }, [selectedFolder, byId]);

  const filtered = useMemo(
    () =>
      all
        .filter((t) =>
          folderFilter === "__all"
            ? true
            : folderFilter === "__unfiled"
              ? t.folderId == null
              : t.folderId === folderFilter,
        )
        .filter((t) => !tagFilter || t.tags.includes(tagFilter)),
    [all, folderFilter, tagFilter],
  );

  function dropToFolder(folderId: string | null) {
    if (!dragId) return;
    const test = all.find((t) => t.id === dragId);
    setDragId(null);
    if (!test || test.folderId === folderId) return;
    const name = folderId ? folders.data?.find((f) => f.id === folderId)?.name : "Unfiled";
    update.mutate(
      { id: test.id, body: { folderId } },
      {
        onSuccess: () => toast(`Moved “${test.name}” to ${name}`),
        onError: (e) => toast(e instanceof Error ? e.message : "Move failed"),
      },
    );
  }

  function clearFilters() {
    setFolderFilter("__all");
    setTagFilter(null);
  }

  if (tests.isLoading) {
    return (
      <div className={styles.layout}>
        <Skeleton height={360} radius="var(--radius-xl)" />
        <div className={styles.loadingList}>
          <Skeleton height={40} radius="var(--radius-md)" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={64} radius="var(--radius-lg)" />
          ))}
        </div>
      </div>
    );
  }

  if (tests.isError) {
    return (
      <ErrorState
        title="Couldn’t load tests"
        description="GET /tests failed. Check the API connection and try again."
        onRetry={() => tests.refetch()}
      />
    );
  }

  if (all.length === 0) {
    return (
      <EmptyState
        icon={<Flask />}
        title="No tests yet"
        description="Record your first test in the Varys Chrome extension. Saved recordings appear here, ready to file, tag and run."
        action={
          <span className={styles.recorderHint}>
            <ExternalLink size={15} />
            Open the recorder
          </span>
        }
      />
    );
  }

  const canClear = folderFilter !== "__all" || tagFilter !== null;

  return (
    <div>
      <TagFilter
        tags={tags.data ?? []}
        activeTag={tagFilter}
        onToggle={(t) => setTagFilter((cur) => (cur === t ? null : t))}
        onClear={clearFilters}
        canClear={canClear}
      />
      <div className={styles.layout}>
        <FolderRail
          folders={folders.data ?? []}
          allCount={all.length}
          unfiledCount={unfiledCount}
          active={folderFilter}
          onSelect={setFolderFilter}
          dragActive={dragId !== null}
          onDropToFolder={dropToFolder}
        />
        <div className={styles.listCard}>
          {/* Path bar — drill UP from the main view (each crumb jumps there). */}
          {(selectedFolder || folderFilter === "__unfiled") && (
            <nav className={styles.pathBar} aria-label="Folder path">
              <button type="button" className={styles.crumb} onClick={() => setFolderFilter("__all")}>
                All tests
              </button>
              {crumbs.map((c) => (
                <span key={c.id} className={styles.crumbWrap}>
                  <ChevronRight size={13} className={styles.crumbSep} />
                  <button type="button" className={styles.crumb} onClick={() => setFolderFilter(c.id)}>
                    {c.name}
                  </button>
                </span>
              ))}
              {folderFilter === "__unfiled" && (
                <span className={styles.crumbWrap}>
                  <ChevronRight size={13} className={styles.crumbSep} />
                  <span className={styles.crumbCurrent}>Unfiled</span>
                </span>
              )}
            </nav>
          )}

          {/* Subfolder icons — double-click to open, like a desktop file browser. */}
          {childFolders.length > 0 && (
            <div className={styles.subfolders}>
              {childFolders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={styles.folderIconTile}
                  onDoubleClick={() => setFolderFilter(f.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setFolderFilter(f.id);
                  }}
                  title={`Double-click to open ${f.name}`}
                >
                  <span className={styles.folderGlyph}>
                    <Folder size={44} />
                    {f.testCount > 0 && <span className={styles.folderBadge}>{f.testCount}</span>}
                  </span>
                  <span className={styles.folderLabel}>{f.name}</span>
                </button>
              ))}
            </div>
          )}

          {filtered.length === 0 ? (
            childFolders.length > 0 ? (
              <div className={styles.subEmpty}>
                No tests directly in this folder — open a subfolder above, or drag a test here.
              </div>
            ) : (
              <div className={styles.filteredEmpty}>
                <span className={styles.filteredIcon}>
                  <Search size={22} />
                </span>
                <div className={styles.filteredTitle}>No tests match these filters</div>
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              </div>
            )
          ) : (
            filtered.map((t) => (
              <TestRow
                key={t.id}
                test={t}
                folders={folders.data ?? []}
                allTags={tags.data ?? []}
                isDragging={dragId === t.id}
                onDragStart={setDragId}
                onDragEnd={() => setDragId(null)}
                onRun={openRunDialog}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
