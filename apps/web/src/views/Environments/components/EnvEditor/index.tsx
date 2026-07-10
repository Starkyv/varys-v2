import type { EnvCookie, EnvLocalStorageItem, EnvironmentView } from "@varys/review-contract";
import { Button, Database, Input, Lock, Trash } from "@varys/ui";
import { useState } from "react";
import { useConfirm } from "../../../../context/confirm";
import { useToast } from "../../../../context/toast";
import { useDeleteEnvironment, useUpdateEnvironment } from "../../../../queries";
import styles from "./styles.module.scss";

export function EnvEditor({ env, onDeleted }: { env: EnvironmentView; onDeleted: () => void }) {
  const update = useUpdateEnvironment();
  const remove = useDeleteEnvironment();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [name, setName] = useState(env.name);
  const [values, setValues] = useState<Record<string, string>>({ ...env.values });
  const [cookies, setCookies] = useState<EnvCookie[]>(env.cookies ?? []);
  const [localItems, setLocalItems] = useState<EnvLocalStorageItem[]>(env.localStorage ?? []);
  const [newVarKey, setNewVarKey] = useState("");
  const [newVarVal, setNewVarVal] = useState("");
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretVal, setNewSecretVal] = useState("");
  const [newCookieName, setNewCookieName] = useState("");
  const [newCookieVal, setNewCookieVal] = useState("");
  const [newCookieDomain, setNewCookieDomain] = useState("");
  const [newLocalKey, setNewLocalKey] = useState("");
  const [newLocalVal, setNewLocalVal] = useState("");
  const [newLocalOrigin, setNewLocalOrigin] = useState("");

  const onError = (e: unknown) => toast(e instanceof Error ? e.message : "Update failed");

  function save() {
    update.mutate(
      { id: env.id, body: { name: name.trim() || env.name, values, cookies, localStorage: localItems } },
      { onSuccess: () => toast("Environment saved"), onError },
    );
  }

  function patchCookie(cookieName: string, patch: Partial<EnvCookie>) {
    setCookies((cs) => cs.map((c) => (c.name === cookieName ? { ...c, ...patch } : c)));
  }

  function addCookie() {
    const cn = newCookieName.trim();
    if (!cn) return;
    const cookie: EnvCookie = { name: cn, value: newCookieVal };
    if (newCookieDomain.trim()) cookie.domain = newCookieDomain.trim();
    setCookies((cs) => [...cs.filter((c) => c.name !== cn), cookie]);
    setNewCookieName("");
    setNewCookieVal("");
    setNewCookieDomain("");
  }

  function removeCookie(cookieName: string) {
    setCookies((cs) => cs.filter((c) => c.name !== cookieName));
  }

  function patchLocalItem(itemKey: string, patch: Partial<EnvLocalStorageItem>) {
    setLocalItems((items) => items.map((it) => (it.key === itemKey ? { ...it, ...patch } : it)));
  }

  function addLocalItem() {
    const k = newLocalKey.trim();
    if (!k) return;
    const item: EnvLocalStorageItem = { key: k, value: newLocalVal };
    if (newLocalOrigin.trim()) item.origin = newLocalOrigin.trim();
    setLocalItems((items) => [...items.filter((it) => it.key !== k), item]);
    setNewLocalKey("");
    setNewLocalVal("");
    setNewLocalOrigin("");
  }

  function removeLocalItem(itemKey: string) {
    setLocalItems((items) => items.filter((it) => it.key !== itemKey));
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

  async function onDelete() {
    const ok = await confirm({
      title: `Delete environment “${env.name}”?`,
      message: "Tests that reference it will need another environment to run.",
      confirmLabel: "Delete environment",
      tone: "danger",
    });
    if (!ok) return;
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
        <Button variant="ghost" size="sm" className={styles.delete} loading={remove.isPending} onClick={() => void onDelete()}>
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

        <div className={styles.secretsHead}>
          <span className={styles.sectionTitle}>Cookies</span>
          <span className={styles.secretsHint}>set before each run · value supports {"{{secret:NAME}}"}</span>
        </div>
        <div className={styles.rows}>
          {cookies.map((c) => (
            <div key={c.name} className={styles.varRow}>
              <span className={styles.varKey}>{c.name}</span>
              <Input
                className={styles.cookieField}
                mono
                inputSize="sm"
                value={c.value}
                placeholder="value or {{secret:NAME}}"
                onChange={(e) => patchCookie(c.name, { value: e.target.value })}
                aria-label={`${c.name} value`}
              />
              <Input
                className={styles.cookieField}
                mono
                inputSize="sm"
                value={c.domain ?? ""}
                placeholder="domain (defaults to baseUrl)"
                onChange={(e) => patchCookie(c.name, { domain: e.target.value.trim() || undefined })}
                aria-label={`${c.name} domain`}
              />
              <button type="button" className={styles.remove} aria-label={`Remove ${c.name}`} onClick={() => removeCookie(c.name)}>
                <Trash size={14} />
              </button>
            </div>
          ))}
          {cookies.length === 0 && <div className={styles.none}>No cookies yet.</div>}
        </div>
        <div className={styles.addRow}>
          <input className={styles.addKey} placeholder="cookie name" value={newCookieName} onChange={(e) => setNewCookieName(e.target.value)} />
          <input className={styles.addVal} placeholder="value or {{secret:NAME}}" value={newCookieVal} onChange={(e) => setNewCookieVal(e.target.value)} />
          <input className={styles.addVal} placeholder="domain (optional)" value={newCookieDomain} onChange={(e) => setNewCookieDomain(e.target.value)} />
          <Button variant="secondary" size="sm" onClick={addCookie} disabled={!newCookieName.trim()}>
            Add cookie
          </Button>
        </div>

        <div className={styles.secretsHead}>
          <span className={styles.sectionTitle}>Local storage</span>
          <span className={styles.secretsHint}>set before each run · value supports {"{{secret:NAME}}"}</span>
        </div>
        <div className={styles.rows}>
          {localItems.map((it) => (
            <div key={it.key} className={styles.varRow}>
              <span className={styles.varKey}>{it.key}</span>
              <Input
                className={styles.cookieField}
                mono
                inputSize="sm"
                value={it.value}
                placeholder="value or {{secret:NAME}}"
                onChange={(e) => patchLocalItem(it.key, { value: e.target.value })}
                aria-label={`${it.key} value`}
              />
              <Input
                className={styles.cookieField}
                mono
                inputSize="sm"
                value={it.origin ?? ""}
                placeholder="origin (defaults to baseUrl)"
                onChange={(e) => patchLocalItem(it.key, { origin: e.target.value.trim() || undefined })}
                aria-label={`${it.key} origin`}
              />
              <button type="button" className={styles.remove} aria-label={`Remove ${it.key}`} onClick={() => removeLocalItem(it.key)}>
                <Trash size={14} />
              </button>
            </div>
          ))}
          {localItems.length === 0 && <div className={styles.none}>No local storage entries yet.</div>}
        </div>
        <div className={styles.addRow}>
          <input className={styles.addKey} placeholder="key" value={newLocalKey} onChange={(e) => setNewLocalKey(e.target.value)} />
          <input className={styles.addVal} placeholder="value or {{secret:NAME}}" value={newLocalVal} onChange={(e) => setNewLocalVal(e.target.value)} />
          <input className={styles.addVal} placeholder="origin (optional)" value={newLocalOrigin} onChange={(e) => setNewLocalOrigin(e.target.value)} />
          <Button variant="secondary" size="sm" onClick={addLocalItem} disabled={!newLocalKey.trim()}>
            Add entry
          </Button>
        </div>
        <p className={styles.cookieNote}>Cookies &amp; local storage are saved with the environment — click Save to apply.</p>
      </div>
    </div>
  );
}
