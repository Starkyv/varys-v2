import type { EnvironmentView } from "@varys/review-contract";
import { cx, Plus } from "@varys/ui";
import { useState } from "react";
import styles from "./styles.module.scss";

export function EnvRail({
  environments,
  selectedId,
  onSelect,
  onCreate,
  creating,
}: {
  environments: EnvironmentView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  creating: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  function commit() {
    const trimmed = name.trim();
    if (trimmed) onCreate(trimmed);
    setName("");
    setAdding(false);
  }

  return (
    <div className={styles.rail}>
      <div className={styles.title}>Deployments</div>
      <div className={styles.items}>
        {environments.map((e) => {
          const sel = e.id === selectedId;
          return (
            <button key={e.id} type="button" className={cx(styles.item, sel && styles.active)} onClick={() => onSelect(e.id)}>
              <span className={styles.dot} style={{ background: sel ? "var(--color-primary)" : "var(--color-neutral-300)" }} />
              <span className={styles.text}>
                <span className={styles.name}>{e.name}</span>
                <span className={styles.meta}>
                  {e.baseUrl || "no base URL"} · {e.cookies.length} cookie{e.cookies.length === 1 ? "" : "s"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {adding ? (
        <input
          autoFocus
          className={styles.newInput}
          placeholder="environment-name"
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          onBlur={commit}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") commit();
            if (ev.key === "Escape") {
              setName("");
              setAdding(false);
            }
          }}
        />
      ) : (
        <button type="button" className={styles.newBtn} disabled={creating} onClick={() => setAdding(true)}>
          <Plus size={14} />
          New environment
        </button>
      )}
    </div>
  );
}
