import type { FolderSummary, TestSummary } from "@varys/review-contract";
import { useEffect, useState } from "react";
import {
  useCreateFolder,
  useDeleteFolder,
  useEnvironments,
  useFolders,
  useRenameFolder,
  useRunTest,
  useTags,
  useTests,
  useUpdateTest,
} from "./queries";
import styles from "./TestsList.module.css";

/** Remember the last-used environment across reloads, so Run defaults to it. */
const LAST_ENV_KEY = "varys:lastEnvId";

/**
 * The Tests view: the saved recordings, each runnable on demand against a chosen
 * environment, organized into flat folders. Recording (in the extension) only *saves*
 * a test — this is where you find it (browse by folder, see Unfiled strays), organize
 * it (rename, file), pick an environment, and press Run.
 *
 * Organization is metadata around the test (relational) — renaming/filing never
 * creates a test version and can't touch baselines or review state.
 *
 * Requirement rule (unchanged): a test that references variables/secrets
 * (`needsEnvironment`) can't be run without an environment.
 */
export function TestsList() {
  const { data, isLoading, isError, error } = useTests();
  const envs = useEnvironments();
  const folders = useFolders();
  const tags = useTags();
  const run = useRunTest();
  const createFolder = useCreateFolder();
  const renameFolder = useRenameFolder();
  const deleteFolder = useDeleteFolder();

  // The environment to run against (shared across the rows), seeded from the last use.
  const [envId, setEnvId] = useState<string>(() => localStorage.getItem(LAST_ENV_KEY) ?? "");
  // Folder filter: "all" | "unfiled" | a folder id.
  const [folderFilter, setFolderFilter] = useState<string>("all");
  // Tag filter: "all" | a tag — slices across folder boundaries.
  const [tagFilter, setTagFilter] = useState<string>("all");
  // Which test's organize editor is open (one at a time).
  const [organizing, setOrganizing] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");

  // Drop a remembered environment that no longer exists, so a stale id can't be sent.
  useEffect(() => {
    if (envId && envs.data && !envs.data.some((e) => e.id === envId)) {
      setEnvId("");
      localStorage.removeItem(LAST_ENV_KEY);
    }
  }, [envId, envs.data]);

  // A deleted folder can leave the filter pointing at nothing — fall back to All.
  useEffect(() => {
    if (
      folderFilter !== "all" &&
      folderFilter !== "unfiled" &&
      folders.data &&
      !folders.data.some((f) => f.id === folderFilter)
    ) {
      setFolderFilter("all");
    }
  }, [folderFilter, folders.data]);

  // Likewise a tag that's no longer in use anywhere.
  useEffect(() => {
    if (tagFilter !== "all" && tags.data && !tags.data.includes(tagFilter)) {
      setTagFilter("all");
    }
  }, [tagFilter, tags.data]);

  const chooseEnv = (id: string) => {
    setEnvId(id);
    if (id) localStorage.setItem(LAST_ENV_KEY, id);
    else localStorage.removeItem(LAST_ENV_KEY);
  };

  const onCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    createFolder.mutate(name, { onSuccess: () => setNewFolderName("") });
  };

  const selectedFolder = folders.data?.find((f) => f.id === folderFilter);

  const onRenameFolder = () => {
    if (!selectedFolder) return;
    const name = window.prompt("Rename folder", selectedFolder.name)?.trim();
    if (name && name !== selectedFolder.name) {
      renameFolder.mutate({ id: selectedFolder.id, name });
    }
  };

  const onDeleteFolder = () => {
    if (!selectedFolder) return;
    if (
      window.confirm(
        `Delete folder “${selectedFolder.name}”? Its ${selectedFolder.testCount} test${selectedFolder.testCount === 1 ? "" : "s"} will become Unfiled (not deleted).`,
      )
    ) {
      deleteFolder.mutate(selectedFolder.id);
    }
  };

  if (isLoading) {
    return (
      <p role="status" className={styles.notice}>
        Loading tests…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className={styles.error}>
        Couldn’t load tests: {(error as Error).message}
      </p>
    );
  }
  if (!data) return null;
  if (data.length === 0) {
    return <p className={styles.empty}>No saved tests yet — record one with the extension.</p>;
  }

  const noEnvs = !!envs.data && envs.data.length === 0;
  const folderError = createFolder.error ?? renameFolder.error ?? deleteFolder.error;

  const visible = data
    .filter((t) =>
      folderFilter === "all"
        ? true
        : folderFilter === "unfiled"
          ? t.folderId == null
          : t.folderId === folderFilter,
    )
    .filter((t) => tagFilter === "all" || t.tags.includes(tagFilter));

  return (
    <main className={styles.list}>
      <h1>Tests</h1>

      <div className={styles.envBar}>
        <label htmlFor="run-env">Run against:</label>
        <select
          id="run-env"
          className={styles.envSelect}
          value={envId}
          onChange={(e) => chooseEnv(e.target.value)}
        >
          <option value="">No environment</option>
          {envs.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        {noEnvs && (
          <a className={styles.envHint} href="?view=environments">
            No environments yet — create one
          </a>
        )}
      </div>

      <div className={styles.folderBar}>
        <label htmlFor="folder-filter">Folder:</label>
        <select
          id="folder-filter"
          className={styles.envSelect}
          value={folderFilter}
          onChange={(e) => setFolderFilter(e.target.value)}
        >
          <option value="all">All folders</option>
          <option value="unfiled">Unfiled</option>
          {folders.data?.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} ({f.testCount})
            </option>
          ))}
        </select>
        {selectedFolder && (
          <>
            <button type="button" className={styles.smallBtn} onClick={onRenameFolder}>
              Rename
            </button>
            <button
              type="button"
              className={`${styles.smallBtn} ${styles.smallDanger}`}
              onClick={onDeleteFolder}
            >
              Delete
            </button>
          </>
        )}
        {(tags.data?.length ?? 0) > 0 && (
          <>
            <label htmlFor="tag-filter">Tag:</label>
            <select
              id="tag-filter"
              className={styles.envSelect}
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
            >
              <option value="all">All tags</option>
              {tags.data?.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </>
        )}
        <span className={styles.folderSpacer} />
        <input
          className={styles.folderInput}
          placeholder="New folder name"
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCreateFolder();
          }}
        />
        <button
          type="button"
          className={styles.smallBtn}
          disabled={createFolder.isPending || !newFolderName.trim()}
          onClick={onCreateFolder}
        >
          Create
        </button>
      </div>
      {folderError && (
        <p role="alert" className={styles.error}>
          {(folderError as Error).message}
        </p>
      )}

      {run.isSuccess && run.data && (
        <p role="status" className={styles.notice}>
          Run started — <a href={`?run=${run.data.runId}`}>view it</a>, or it’ll appear under
          Needs review shortly.
        </p>
      )}
      {run.isError && (
        <p role="alert" className={styles.error}>
          Couldn’t start run: {(run.error as Error).message}
        </p>
      )}

      {visible.length === 0 ? (
        <p className={styles.empty}>No tests in this folder.</p>
      ) : (
        <ul className={styles.items}>
          {visible.map((t) => {
            const blocked = t.needsEnvironment && !envId;
            return (
              <li key={t.id}>
                <div className={styles.row}>
                  <span className={styles.name}>{t.name}</span>
                  {folderFilter === "all" && (
                    <span className={styles.folderTag}>{t.folderName ?? "Unfiled"}</span>
                  )}
                  {t.tags.map((tag) => (
                    <span key={tag} className={styles.tagChip}>
                      {tag}
                    </span>
                  ))}
                  {t.needsEnvironment && (
                    <span
                      className={styles.badge}
                      title="References variables — needs an environment"
                    >
                      needs env
                    </span>
                  )}
                  <span className={styles.time}>{new Date(t.createdAt).toLocaleString()}</span>
                  <button
                    type="button"
                    className={styles.smallBtn}
                    title="Rename or move this test"
                    aria-label={`Organize ${t.name}`}
                    onClick={() => setOrganizing(organizing === t.id ? null : t.id)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className={styles.run}
                    disabled={run.isPending || blocked}
                    title={
                      blocked
                        ? "This test references variables — pick an environment to run it."
                        : undefined
                    }
                    onClick={() => run.mutate({ testId: t.id, environmentId: envId || undefined })}
                  >
                    Run
                  </button>
                </div>
                {organizing === t.id && (
                  <OrganizeEditor
                    test={t}
                    folders={folders.data ?? []}
                    allTags={tags.data ?? []}
                    onDone={() => setOrganizing(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

/**
 * Inline organize editor for one test: rename, set/clear folder, and edit tags in a
 * single save (tags are a full-list replace server-side). Pure organization
 * metadata — the server writes only organization rows (no new version).
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
  const [name, setName] = useState(test.name);
  const [folderId, setFolderId] = useState<string>(test.folderId ?? "");
  const [editTags, setEditTags] = useState<string[]>(test.tags);
  const [tagInput, setTagInput] = useState("");

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag && !editTags.includes(tag)) setEditTags((ts) => [...ts, tag]);
    setTagInput("");
  };
  const removeTag = (tag: string) => setEditTags((ts) => ts.filter((t) => t !== tag));

  const onSave = () => {
    // An unconfirmed tag still in the input counts — losing it on Save is surprising.
    const pending = tagInput.trim();
    const tags = pending && !editTags.includes(pending) ? [...editTags, pending] : editTags;
    update.mutate(
      {
        id: test.id,
        body: { name: name.trim() || test.name, folderId: folderId || null, tags },
      },
      { onSuccess: onDone },
    );
  };

  return (
    <div className={styles.organizeRow}>
      <input
        aria-label="Test name"
        className={styles.folderInput}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave();
        }}
      />
      <select
        aria-label="Folder"
        className={styles.envSelect}
        value={folderId}
        onChange={(e) => setFolderId(e.target.value)}
      >
        <option value="">— Unfiled —</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={styles.smallBtn}
        disabled={update.isPending}
        onClick={onSave}
      >
        {update.isPending ? "Saving…" : "Save"}
      </button>
      <button type="button" className={styles.smallBtn} onClick={onDone}>
        Cancel
      </button>

      <div className={styles.tagEditor}>
        {editTags.map((tag) => (
          <span key={tag} className={styles.tagChip}>
            {tag}
            <button
              type="button"
              className={styles.tagRemove}
              aria-label={`Remove tag ${tag}`}
              onClick={() => removeTag(tag)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          aria-label="Add tag"
          className={styles.folderInput}
          placeholder="Add tag (e.g. release:5.0)"
          list="known-tags"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
        />
        <datalist id="known-tags">
          {allTags
            .filter((t) => !editTags.includes(t))
            .map((t) => (
              <option key={t} value={t} />
            ))}
        </datalist>
        <button
          type="button"
          className={styles.smallBtn}
          disabled={!tagInput.trim()}
          onClick={addTag}
        >
          Add
        </button>
      </div>

      {update.isError && (
        <p role="alert" className={styles.error}>
          {(update.error as Error).message}
        </p>
      )}
    </div>
  );
}
