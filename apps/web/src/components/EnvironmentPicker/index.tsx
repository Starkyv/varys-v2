import type { EnvironmentView } from "@varys/review-contract";
import { cx } from "@varys/ui";
import styles from "./styles.module.scss";

export interface EnvironmentPickerProps {
  environments: EnvironmentView[];
  /** The chosen environment's id, or null. What null MEANS depends on `noneOption`: with one it
   *  is the deliberate "no environment" choice, without one it is "nothing picked yet". */
  value: string | null;
  onChange: (environmentId: string | null) => void;
  /** Offer an explicit "no environment" row. Omit it where an environment is required. */
  noneOption?: { label: string; hint: string };
  /** Shown in place of the list when there are no environments at all. */
  emptyHint?: string;
  ariaLabel: string;
}

/**
 * Pick one environment from a list of rows.
 *
 * Rows rather than a `<Select>` because the base URL is as much a part of the choice as the name:
 * "staging" and "staging-eu" are indistinguishable until you can see where each one points, and
 * an environment picked by name alone is how a run ends up comparing against the wrong baselines.
 *
 * The optional "no environment" row is a real choice, not a placeholder — an Agent-Driven Test can
 * legitimately run against none, and leaving that as an empty selection would make "I haven't
 * chosen" and "I chose nothing" the same state.
 */
export function EnvironmentPicker({
  environments,
  value,
  onChange,
  noneOption,
  emptyHint,
  ariaLabel,
}: EnvironmentPickerProps) {
  const rows = [
    ...(noneOption ? [{ id: null, name: noneOption.label, detail: noneOption.hint }] : []),
    ...environments.map((env) => ({ id: env.id as string | null, name: env.name, detail: env.baseUrl })),
  ];

  if (rows.length === 0) {
    return <div className={styles.envEmpty}>{emptyHint ?? "No environments yet — add one under Environments."}</div>;
  }

  return (
    <div className={styles.envList} role="radiogroup" aria-label={ariaLabel}>
      {rows.map((row) => {
        const selected = value === row.id;
        return (
          <button
            key={row.id ?? "__none__"}
            type="button"
            role="radio"
            aria-checked={selected}
            className={cx(styles.envRow, selected && styles.envRowSel)}
            onClick={() => onChange(row.id)}
          >
            <span className={cx(styles.radio, selected && styles.radioSel)}>
              <span className={styles.radioDot} />
            </span>
            <span className={styles.envName}>{row.name}</span>
            <span className={styles.envUrl}>{row.detail}</span>
          </button>
        );
      })}
    </div>
  );
}
