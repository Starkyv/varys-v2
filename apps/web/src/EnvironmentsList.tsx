import type { EnvironmentView } from "@varys/review-contract";
import { useId, useState } from "react";
import {
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironments,
  useUpdateEnvironment,
} from "./queries";
import styles from "./EnvironmentsList.module.css";

/**
 * The Environments view: create / edit / delete the deployments a test runs
 * against. Each environment carries a `baseUrl` + named values (resolved into a
 * recording's `{{tokens}}`) and named secrets. Secrets are WRITE-ONLY — the API
 * never returns their values, so the editor only ever shows names + set/clear
 * controls, never a value bound into an input. Free-form key/value to match the
 * `jsonb` shape (PRD §G); declared-variable-driven forms can come later.
 *
 * Manual-verified (no UI/MSW tests, per direction).
 */
export function EnvironmentsList() {
  const { data, isLoading, isError, error } = useEnvironments();
  const create = useCreateEnvironment();
  const [newName, setNewName] = useState("");

  if (isLoading) {
    return (
      <p role="status" className={styles.notice}>
        Loading environments…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className={styles.error}>
        Couldn’t load environments: {(error as Error).message}
      </p>
    );
  }

  const onCreate = () => {
    const name = newName.trim();
    if (!name) return;
    create.mutate({ name }, { onSuccess: () => setNewName("") });
  };

  return (
    <main className={styles.list}>
      <h1>Environments</h1>

      <div className={styles.newRow}>
        <input
          className={styles.input}
          placeholder="New environment name (e.g. dev)"
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
        <p className={styles.empty}>
          No environments yet — create one above (give it a <code>baseUrl</code> value and your login
          secret).
        </p>
      ) : (
        <ul className={styles.items}>
          {data?.map((env) => (
            <li key={env.id}>
              <EnvironmentCard env={env} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

interface ValueRow {
  id: number;
  key: string;
  value: string;
}

let rowSeq = 0;
const toRows = (values: Record<string, string>): ValueRow[] =>
  Object.entries(values).map(([key, value]) => ({ id: rowSeq++, key, value }));

/**
 * One environment, editable in place. Holds local form state seeded from the env;
 * Save sends a full `values` replace plus a secret delta (sets from the pending
 * add-list, clears from the toggled names). Secret values live only in local state
 * until Save and are never displayed back.
 */
function EnvironmentCard({ env }: { env: EnvironmentView }) {
  const update = useUpdateEnvironment();
  const del = useDeleteEnvironment();
  const baseId = useId();

  const [name, setName] = useState(env.name);
  const [rows, setRows] = useState<ValueRow[]>(() => toRows(env.values));
  // Secrets to clear on save (toggled from the existing names).
  const [clear, setClear] = useState<Set<string>>(new Set());
  // New secrets to set on save: name → value (held locally, names shown as chips).
  const [pending, setPending] = useState<Record<string, string>>({});
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");

  const setRow = (id: number, patch: Partial<ValueRow>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { id: rowSeq++, key: "", value: "" }]);
  const removeRow = (id: number) => setRows((rs) => rs.filter((r) => r.id !== id));

  const toggleClear = (n: string) =>
    setClear((c) => {
      const next = new Set(c);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const addPendingSecret = () => {
    const n = secretName.trim();
    if (!n) return;
    setPending((p) => ({ ...p, [n]: secretValue }));
    setSecretName("");
    setSecretValue("");
  };
  const dropPendingSecret = (n: string) =>
    setPending((p) => {
      const next = { ...p };
      delete next[n];
      return next;
    });

  const onSave = () => {
    // Build the values map from non-empty keys (last write wins on dup keys).
    const values: Record<string, string> = {};
    for (const r of rows) {
      const k = r.key.trim();
      if (k) values[k] = r.value;
    }
    update.mutate({
      id: env.id,
      body: {
        name: name.trim() || env.name,
        values,
        secrets: pending,
        removeSecrets: [...clear],
      },
    });
    // The set/clear deltas have been applied server-side; reset the transient bits.
    setPending({});
    setClear(new Set());
  };

  const onDelete = () => {
    if (window.confirm(`Delete environment “${env.name}”? This cannot be undone.`)) {
      del.mutate(env.id);
    }
  };

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <input
          aria-label="Environment name"
          className={styles.nameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.primary}
            disabled={update.isPending}
            onClick={onSave}
          >
            {update.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            className={styles.danger}
            disabled={del.isPending}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>

      {(update.isError || del.isError) && (
        <p role="alert" className={styles.error}>
          {((update.error ?? del.error) as Error).message}
        </p>
      )}

      <h3 className={styles.section}>Values</h3>
      <div className={styles.kv}>
        {rows.map((r) => (
          <div key={r.id} className={styles.kvRow}>
            <input
              aria-label="Value name"
              className={styles.input}
              placeholder="name (e.g. baseUrl)"
              value={r.key}
              onChange={(e) => setRow(r.id, { key: e.target.value })}
            />
            <input
              aria-label="Value"
              className={styles.input}
              placeholder="value"
              value={r.value}
              onChange={(e) => setRow(r.id, { value: e.target.value })}
            />
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Remove value"
              onClick={() => removeRow(r.id)}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className={styles.addBtn} onClick={addRow}>
          + Add value
        </button>
      </div>

      <h3 className={styles.section}>Secrets</h3>
      <p className={styles.hint}>Values are write-only — only names are shown.</p>
      <ul className={styles.secrets}>
        {env.secretNames.length === 0 && Object.keys(pending).length === 0 && (
          <li className={styles.secretEmpty}>No secrets set.</li>
        )}
        {env.secretNames.map((n) => (
          <li key={n} className={styles.secretRow}>
            <span className={styles.lock}>🔒 {n}</span>
            <label className={styles.clearLabel}>
              <input
                type="checkbox"
                checked={clear.has(n)}
                onChange={() => toggleClear(n)}
              />
              clear on save
            </label>
          </li>
        ))}
        {Object.keys(pending).map((n) => (
          <li key={`pending-${n}`} className={styles.secretRow}>
            <span className={styles.lock}>🔒 {n}</span>
            <span className={styles.pendingTag}>will set on save</span>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Discard new secret"
              onClick={() => dropPendingSecret(n)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className={styles.kvRow}>
        <input
          id={`${baseId}-secret-name`}
          aria-label="New secret name"
          className={styles.input}
          placeholder="secret name (e.g. password)"
          value={secretName}
          onChange={(e) => setSecretName(e.target.value)}
        />
        <input
          id={`${baseId}-secret-value`}
          aria-label="New secret value"
          className={styles.input}
          type="password"
          placeholder="secret value"
          value={secretValue}
          onChange={(e) => setSecretValue(e.target.value)}
        />
        <button
          type="button"
          className={styles.addBtn}
          disabled={!secretName.trim()}
          onClick={addPendingSecret}
        >
          Add secret
        </button>
      </div>
    </section>
  );
}
