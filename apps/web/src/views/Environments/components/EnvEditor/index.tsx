import type { EnvironmentView } from "@varys/review-contract";
import { Button, Database, Input, Lock, Trash } from "@varys/ui";
import { useState } from "react";
import { useToast } from "../../../../context/toast";
import { useDeleteEnvironment, useUpdateEnvironment } from "../../../../queries";
import styles from "./styles.module.scss";

export function EnvEditor({ env, onDeleted }: { env: EnvironmentView; onDeleted: () => void }) {
  const update = useUpdateEnvironment();
  const remove = useDeleteEnvironment();
  const { toast } = useToast();

  const [name, setName] = useState(env.name);
  const [values, setValues] = useState<Record<string, string>>({ ...env.values });
  const [newVarKey, setNewVarKey] = useState("");
  const [newVarVal, setNewVarVal] = useState("");
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretVal, setNewSecretVal] = useState("");

  const onError = (e: unknown) => toast(e instanceof Error ? e.message : "Update failed");

  function save() {
    update.mutate(
      { id: env.id, body: { name: name.trim() || env.name, values } },
      { onSuccess: () => toast("Environment saved"), onError },
    );
  }

  function addVariable() {
    const key = newVarKey.trim();
    if (!key) return;
    setValues((v) => ({ ...v, [key]: newVarVal }));
    setNewVarKey("");
    setNewVarVal("");
  }

  function removeVariable(key: string) {
    setValues((v) => {
      const next = { ...v };
      delete next[key];
      return next;
    });
  }

  function addSecret() {
    const secretName = newSecretName.trim();
    if (!secretName) return;
    update.mutate(
      { id: env.id, body: { secrets: { [secretName]: newSecretVal } } },
      {
        onSuccess: () => {
          toast(`Secret ${secretName} added (write-only)`);
          setNewSecretName("");
          setNewSecretVal("");
        },
        onError,
      },
    );
  }

  function removeSecret(secretName: string) {
    update.mutate(
      { id: env.id, body: { removeSecrets: [secretName] } },
      { onSuccess: () => toast(`Removed secret ${secretName}`), onError },
    );
  }

  function onDelete() {
    if (!window.confirm(`Delete environment “${env.name}”? Tests that reference it will need another to run.`)) return;
    remove.mutate(env.id, {
      onSuccess: () => {
        toast(`Environment “${env.name}” deleted`);
        onDeleted();
      },
      onError,
    });
  }

  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <Database size={18} />
        </span>
        <div className={styles.headText}>
          <Input className={styles.nameInput} inputSize="sm" value={name} onChange={(e) => setName(e.target.value)} aria-label="Environment name" />
          <div className={styles.sub}>Feeds the run environment pickers</div>
        </div>
        <Button variant="ghost" size="sm" className={styles.delete} loading={remove.isPending} onClick={onDelete}>
          Delete
        </Button>
        <Button variant="primary" size="sm" loading={update.isPending} onClick={save}>
          Save
        </Button>
      </header>

      <div className={styles.body}>
        <div className={styles.sectionTitle}>Variables</div>
        <div className={styles.rows}>
          {Object.entries(values).map(([key, value]) => (
            <div key={key} className={styles.varRow}>
              <span className={styles.varKey}>{key}</span>
              <Input mono inputSize="sm" value={value} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} aria-label={key} />
              <button type="button" className={styles.remove} aria-label={`Remove ${key}`} onClick={() => removeVariable(key)}>
                <Trash size={14} />
              </button>
            </div>
          ))}
          {Object.keys(values).length === 0 && <div className={styles.none}>No variables yet.</div>}
        </div>
        <div className={styles.addRow}>
          <input className={styles.addKey} placeholder="variable" value={newVarKey} onChange={(e) => setNewVarKey(e.target.value)} />
          <input className={styles.addVal} placeholder="value" value={newVarVal} onChange={(e) => setNewVarVal(e.target.value)} />
          <Button variant="secondary" size="sm" onClick={addVariable} disabled={!newVarKey.trim()}>
            Add
          </Button>
        </div>

        <div className={styles.secretsHead}>
          <span className={styles.sectionTitle}>Secrets</span>
          <span className={styles.secretsHint}>
            <Lock size={12} />
            write-only · values never shown
          </span>
        </div>
        <div className={styles.rows}>
          {env.secretNames.map((secretName) => (
            <div key={secretName} className={styles.secretRow}>
              <span className={styles.secretIcon}>
                <Lock size={15} />
              </span>
              <span className={styles.secretName}>{secretName}</span>
              <span className={styles.secretMask}>••••••••</span>
              <button type="button" className={styles.remove} aria-label={`Remove ${secretName}`} onClick={() => removeSecret(secretName)}>
                <Trash size={15} />
              </button>
            </div>
          ))}
          {env.secretNames.length === 0 && <div className={styles.none}>No secrets yet.</div>}
        </div>
        <div className={styles.addRow}>
          <input className={styles.addKey} placeholder="SECRET_NAME" value={newSecretName} onChange={(e) => setNewSecretName(e.target.value)} />
          <input className={styles.addVal} type="password" placeholder="value" value={newSecretVal} onChange={(e) => setNewSecretVal(e.target.value)} />
          <Button variant="secondary" size="sm" onClick={addSecret} disabled={!newSecretName.trim()} loading={update.isPending}>
            Add secret
          </Button>
        </div>
      </div>
    </div>
  );
}
