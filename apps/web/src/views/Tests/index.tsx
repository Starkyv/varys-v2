import { Button, EmptyState, ErrorState, ExternalLink, Flask, Search, Skeleton } from "@varys/ui";
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

  const counts = useMemo(() => {
    const byId: Record<string, number> = {};
    let unfiled = 0;
    for (const t of all) {
      if (t.folderId) byId[t.folderId] = (byId[t.folderId] ?? 0) + 1;
      else unfiled += 1;
    }
    return { all: all.length, unfiled, byId };
  }, [all]);

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
          counts={counts}
          active={folderFilter}
          onSelect={setFolderFilter}
          dragActive={dragId !== null}
          onDropToFolder={dropToFolder}
        />
        <div className={styles.listCard}>
          {filtered.length === 0 ? (
            <div className={styles.filteredEmpty}>
              <span className={styles.filteredIcon}>
                <Search size={22} />
              </span>
              <div className={styles.filteredTitle}>No tests match these filters</div>
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
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
