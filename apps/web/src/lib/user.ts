/** Helpers for rendering the signed-in user (shared by the top bar and sidebar). */

/** Two-letter avatar initials from a name ("Ada Lovelace" → "AL") or email. */
export function initials(label: string): string {
  const base = label.trim();
  if (!base) return "?";
  const parts = base.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}
