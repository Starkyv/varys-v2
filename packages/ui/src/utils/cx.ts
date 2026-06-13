/**
 * Tiny className combiner — joins truthy class names, skipping falsy ones.
 * No dependency; the one styling helper every component imports.
 *
 *   cx(styles.btn, isActive && styles.active, className)
 */
export type ClassValue = string | number | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  let out = "";
  for (const v of values) {
    if (!v && v !== 0) continue;
    out += (out && " ") + v;
  }
  return out;
}
