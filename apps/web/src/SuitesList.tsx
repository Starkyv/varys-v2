import type { SuiteSummary } from "@varys/review-contract";
import { useState } from "react";
import {
  useCreateSuite,
  useDeleteSuite,
  useEnvironments,
  useSuite,
  useSuites,
  useTests,
  useTriggerSuiteRun,
  useUpdateSuite,
} from "./queries";
import styles from "./SuitesList.module.css";

/**
 * The Suites view: a suite is a named, saved selection of tests — THE run unit
 * (DESIGN §5). Defines and manages suites (create / rename / pick members /
 * delete) and triggers suite runs (`suite × env(s)`): pick environments, Run,
 * land on the aggregated report (`?suiteRun=`).
 *
 * Manual-verified (no UI tests, per direction).
 */
export function SuitesList() {
  const { data, isLoading, isError, error } = useSuites();
  const create = useCreateSuite();
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const onCreate = () => {
    const name = newName.trim();
    if (!name) return;
    create.mutate({ name }, { onSuccess: () => setNewName("") });
  };

  if (isLoading) {
    return (
      <p role="status" className={styles.notice}>
        Loading suites…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className={styles.error}>
        Couldn’t load suites: {(error as Error).message}
      </p>
    );
  }

  return (
    <main className={styles.list}>
      <h1>Suites</h1>
      <p className={styles.subtitle}>
        A suite is a saved selection of tests — the run unit. Run one against any set of
        environments and review the fan-out in its aggregated report.
      </p>

      <div className={styles.newRow}>
        <input
          className={styles.input}
          placeholder="New suite name (e.g. smoke)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCreate();
          }}
        />
        <button
          type="button"
          className={styles.primary}
          disabled={create.isPending || !newName.trim()}
          onClick={onCreate}
        >
          Create
        </button>
      </div>
      {create.isError && (
        <p role="alert" className={styles.error}>
          {(create.error as Error).message}
        </p>
      )}

      {data && data.length === 0 ? (
        <p className={styles.empty}>No suites yet — create one above, then pick its tests.</p>
      ) : (
        <ul className={styles.items}>
          {data?.map((s) => (
            <li key={s.id}>
              <SuiteRow
                suite={s}
                editing={editing === s.id}
                onToggleEdit={() => setEditing(editing === s.id ? null : s.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function SuiteRow({
  suite,
  editing,
  onToggleEdit,
}: {
  suite: SuiteSummary;
  editing: boolean;
  onToggleEdit: () => void;
}) {
  const del = useDeleteSuite();
  const [showRun, setShowRun] = useState(false);

  const onDelete = () => {
    if (
      window.confirm(
        `Delete suite “${suite.name}”? Its ${suite.testCount} member test${suite.testCount === 1 ? "" : "s"} are not deleted — only the selection is.`,
      )
    ) {
      del.mutate(suite.id);
    }
  };

  return (
    <div className={styles.suite}>
      <div className={styles.row}>
        <span className={styles.name}>{suite.name}</span>
        <span className={styles.count}>
          {suite.testCount} test{suite.testCount === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className={styles.primary}
          disabled={suite.testCount === 0}
          title={suite.testCount === 0 ? "Add tests to this suite first" : undefined}
          onClick={() => setShowRun(!showRun)}
        >
          {showRun ? "Close" : "Run…"}
        </button>
        <button type="button" className={styles.smallBtn} onClick={onToggleEdit}>
          {editing ? "Close" : "Edit"}
        </button>
        <button
          type="button"
          className={`${styles.smallBtn} ${styles.smallDanger}`}
          disabled={del.isPending}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
      {del.isError && (
        <p role="alert" className={styles.error}>
          {(del.error as Error).message}
        </p>
      )}
      {showRun && <RunPanel suiteId={suite.id} onDone={() => setShowRun(false)} />}
      {editing && <SuiteEditor suiteId={suite.id} onDone={onToggleEdit} />}
    </div>
  );
}

/** Remembered env selection for suite runs (ids; stale ones dropped on use). */
const ENV_SELECTION_KEY = "varys:lastSuiteRunEnvs";

function loadEnvSelection(): string[] {
  try {
    const ids: unknown = JSON.parse(window.localStorage.getItem(ENV_SELECTION_KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The `suite × env(s)` trigger: pick any set of environments (none = one
 * env-less "default" run per test) and start the fan-out — then land on the
 * aggregated report. The selection is remembered for the next run.
 */
function RunPanel({ suiteId, onDone }: { suiteId: string; onDone: () => void }) {
  const envs = useEnvironments();
  const trigger = useTriggerSuiteRun();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(loadEnvSelection()));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const onStart = () => {
    // Send only ids that still exist — a remembered-but-deleted env must not 404.
    const ids = (envs.data ?? []).filter((e) => selected.has(e.id)).map((e) => e.id);
    trigger.mutate(
      { suiteId, environmentIds: ids },
      {
        onSuccess: ({ suiteRunId }) => {
          try {
            window.localStorage.setItem(ENV_SELECTION_KEY, JSON.stringify(ids));
          } catch {
            // Remembering the selection is best-effort.
          }
          window.location.href = `?suiteRun=${suiteRunId}`;
        },
      },
    );
  };

  return (
    <div className={styles.editor}>
      {envs.isLoading ? (
        <p role="status" className={styles.notice}>
          Loading environments…
        </p>
      ) : (envs.data?.length ?? 0) === 0 ? (
        <p className={styles.hint}>
          No environments defined — each test runs once against “default”.
        </p>
      ) : (
        <>
          <ul className={styles.picker}>
            {envs.data?.map((e) => (
              <li key={e.id}>
                <label className={styles.pickRow}>
                  <input
                    type="checkbox"
                    checked={selected.has(e.id)}
                    onChange={() => toggle(e.id)}
                  />
                  <span className={styles.pickName}>{e.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className={styles.hint}>
            One run per test per selected environment; none selected = one “default” run per
            test.
          </p>
        </>
      )}
      <div className={styles.editorRow}>
        <button
          type="button"
          className={styles.primary}
          disabled={trigger.isPending || envs.isLoading}
          onClick={onStart}
        >
          {trigger.isPending ? "Starting…" : "Start run"}
        </button>
        <button type="button" className={styles.smallBtn} onClick={onDone}>
          Cancel
        </button>
      </div>
      {trigger.isError && (
        <p role="alert" className={styles.error}>
          {(trigger.error as Error).message}
        </p>
      )}
    </div>
  );
}

/**
 * Rename + member picking for one suite. Members load from the suite read-model
 * (so the checkbox state starts from what's saved); Save sends a FULL member-list
 * replace alongside the (possibly unchanged) name.
 */
function SuiteEditor({ suiteId, onDone }: { suiteId: string; onDone: () => void }) {
  const suite = useSuite(suiteId);
  const tests = useTests();
  const update = useUpdateSuite();

  // Local edit state, seeded once the suite arrives (key on data presence).
  const [name, setName] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);

  if (suite.isLoading || tests.isLoading) {
    return (
      <p role="status" className={styles.notice}>
        Loading suite…
      </p>
    );
  }
  if (suite.isError || !suite.data) {
    return (
      <p role="alert" className={styles.error}>
        Couldn’t load this suite{suite.error ? `: ${(suite.error as Error).message}` : ""}.
      </p>
    );
  }

  const effName = name ?? suite.data.name;
  const effSelected = selected ?? new Set(suite.data.tests.map((t) => t.id));

  const toggle = (id: string) => {
    const next = new Set(effSelected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const onSave = () => {
    update.mutate(
      {
        id: suiteId,
        body: { name: effName.trim() || suite.data?.name, testIds: [...effSelected] },
      },
      { onSuccess: onDone },
    );
  };

  return (
    <div className={styles.editor}>
      <div className={styles.editorRow}>
        <input
          aria-label="Suite name"
          className={styles.input}
          value={effName}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className={styles.primary}
          disabled={update.isPending}
          onClick={onSave}
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" className={styles.smallBtn} onClick={onDone}>
          Cancel
        </button>
      </div>

      {tests.data && tests.data.length === 0 ? (
        <p className={styles.empty}>No saved tests yet — record one with the extension.</p>
      ) : (
        <ul className={styles.picker}>
          {tests.data?.map((t) => (
            <li key={t.id}>
              <label className={styles.pickRow}>
                <input
                  type="checkbox"
                  checked={effSelected.has(t.id)}
                  onChange={() => toggle(t.id)}
                />
                <span className={styles.pickName}>{t.name}</span>
                <span className={styles.pickMeta}>{t.folderName ?? "Unfiled"}</span>
                {t.tags.map((tag) => (
                  <span key={tag} className={styles.pickTag}>
                    {tag}
                  </span>
                ))}
              </label>
            </li>
          ))}
        </ul>
      )}

      {update.isError && (
        <p role="alert" className={styles.error}>
          {(update.error as Error).message}
        </p>
      )}
    </div>
  );
}
