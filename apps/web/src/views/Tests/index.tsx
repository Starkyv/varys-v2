import type { FolderSummary } from "@varys/review-contract";
import {
  Button,
  ChevronRight,
  EmptyState,
  ErrorState,
  ExternalLink,
  Flask,
  Lock,
  Play,
  Search,
  SegmentedControl,
  Skeleton,
} from "@varys/ui";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "../../context/router";
import { useRunDialog } from "../../context/run-dialog";
import { useToast } from "../../context/toast";
import { useFolders, useTags, useTests, useUpdateTest } from "../../queries";
import { type FolderFilter, FolderRail } from "./components/FolderRail";
import { TagFilter } from "./components/TagFilter";
import { TestRow } from "./components/TestRow";
import styles from "./styles.module.scss";

/** A macOS-Finder-style blue folder glyph (a lighter back tab + a blue front body). Fixed blues so
 *  it reads as a "folder" in both themes, like Finder. */
function FolderIcon() {
  return (
    <svg width="62" height="50" viewBox="0 0 62 50" aria-hidden="true" focusable="false">
      <path
        d="M4 13a5 5 0 0 1 5-5h13.4a5 5 0 0 1 3.6 1.5L29.5 12H53a5 5 0 0 1 5 5v3H4V13Z"
        fill="#8fc7ff"
      />
      <path d="M4 17h54v23a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V17Z" fill="#3e9bff" />
    </svg>
  );
}

/** A Finder-style document glyph for a test "file" — a white page with a folded corner and a couple
 *  of content lines. Fixed light colors read as "paper" in both themes (like macOS doc icons). */
function FileIcon() {
  return (
    <svg width="44" height="54" viewBox="0 0 44 54" aria-hidden="true" focusable="false">
      <path
        d="M5 5a4 4 0 0 1 4-4h19l11 11v37a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V5Z"
        fill="#ffffff"
        stroke="#cfd6e0"
        strokeWidth="1.5"
      />
      <path d="M28 1v6a4 4 0 0 0 4 4h6" fill="#e9eef4" stroke="#cfd6e0" strokeWidth="1.5" />
      <rect x="12" y="28" width="20" height="2.4" rx="1.2" fill="#c6cedb" />
      <rect x="12" y="35" width="14" height="2.4" rx="1.2" fill="#dbe1ea" />
    </svg>
  );
}

export function Tests() {
  const tests = useTests();
  const folders = useFolders();
  const tags = useTags();
  const update = useUpdateTest();
  const { openRunDialog } = useRunDialog();
  const { toast } = useToast();
  const { route, navigate } = useRouter();

  // The open folder lives in the URL (`?view=tests&folder=<id|unfiled>`) so a shared link reopens
  // it. Derive the filter from the route; changing it navigates (back button drills up).
  const routeFolderId = route.name === "tests" ? route.folderId : undefined;
  const folderFilter: FolderFilter =
    routeFolderId == null ? "__all" : routeFolderId === "unfiled" ? "__unfiled" : routeFolderId;
  const setFolderFilter = useCallback(
    (next: FolderFilter) =>
      navigate({
        name: "tests",
        folderId: next === "__all" ? undefined : next === "__unfiled" ? "unfiled" : next,
      }),
    [navigate],
  );
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // Finder-style icon grid vs. the detailed list. Persisted per-viewer.
  const [viewMode, setViewMode] = useState<"icons" | "list">(() => {
    try {
      return localStorage.getItem("varys.tests.view") === "list" ? "list" : "icons";
    } catch {
      return "icons";
    }
  });
  const setView = (v: "icons" | "list") => {
    setViewMode(v);
    try {
      localStorage.setItem("varys.tests.view", v);
    } catch {
      /* private mode / blocked storage — in-memory only */
    }
  };

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
          {/* Toolbar: breadcrumb (drill UP) on the left, view switcher on the right (Finder-like). */}
          <div className={styles.paneToolbar}>
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
            <SegmentedControl<"icons" | "list">
              ariaLabel="View"
              size="sm"
              options={[
                { value: "icons", label: "Icons" },
                { value: "list", label: "List" },
              ]}
              value={viewMode}
              onValueChange={setView}
            />
          </div>

          {viewMode === "icons" ? (
            childFolders.length === 0 && filtered.length === 0 ? (
              <div className={styles.filteredEmpty}>
                <span className={styles.filteredIcon}>
                  <Search size={22} />
                </span>
                <div className={styles.filteredTitle}>
                  {canClear ? "No tests match these filters" : "This folder is empty"}
                </div>
                {canClear && (
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              // Finder-style icon grid — folders and test "files" together. Double-click opens
              // (folder → in; test → its detail); drag a test onto a folder to move it.
              <div className={styles.iconGrid}>
                {childFolders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={styles.folderIconTile}
                    onDoubleClick={() => setFolderFilter(f.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setFolderFilter(f.id);
                    }}
                    onDragOver={(e) => {
                      if (dragId) e.preventDefault();
                    }}
                    onDrop={() => dropToFolder(f.id)}
                    title={`Double-click to open ${f.name}`}
                  >
                    <span className={styles.folderGlyph}>
                      <FolderIcon />
                      {f.testCount > 0 && <span className={styles.folderBadge}>{f.testCount}</span>}
                    </span>
                    <span className={styles.folderLabel}>{f.name}</span>
                  </button>
                ))}
                {filtered.map((t) => (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    className={`${styles.fileIconTile} ${dragId === t.id ? styles.fileDragging : ""}`}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => setDragId(null)}
                    onDoubleClick={() => navigate({ name: "testDetail", testId: t.id })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") navigate({ name: "testDetail", testId: t.id });
                    }}
                    title={`Double-click to open “${t.name}”`}
                  >
                    <span className={styles.fileGlyph}>
                      <FileIcon />
                      {t.needsEnvironment && (
                        <span className={styles.fileEnvBadge} title="Needs an environment">
                          <Lock size={10} />
                        </span>
                      )}
                    </span>
                    <span className={styles.folderLabel}>{t.name}</span>
                    <button
                      type="button"
                      className={styles.fileRun}
                      title={`Run “${t.name}”`}
                      aria-label={`Run ${t.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openRunDialog(t.id);
                      }}
                    >
                      <Play size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )
          ) : (
            <>
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
                      onDragOver={(e) => {
                        if (dragId) e.preventDefault();
                      }}
                      onDrop={() => dropToFolder(f.id)}
                      title={`Double-click to open ${f.name}`}
                    >
                      <span className={styles.folderGlyph}>
                        <FolderIcon />
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
