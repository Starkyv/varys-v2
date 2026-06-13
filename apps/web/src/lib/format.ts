/**
 * Timestamp formatting for the read-models. The API returns ISO-8601 strings;
 * these render them as the compact relative labels the UI uses ("2m ago") and the
 * fuller absolute form for run-detail headers.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now" · "2m ago" · "3h ago" · "5d ago" · then an absolute date. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso; // already a human string (e.g. mock data)
  const diff = Math.max(0, now - t);
  if (diff < 45_000) return "just now";
  if (diff < HOUR) return `${Math.round(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.round(diff / DAY)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Today, 14:32" · "Apr 12, 14:32" — for the run-detail header. */
export function absoluteTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return `Today, ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** A short calendar date ("Apr 12, 2026") for created-at columns. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A diff score in [0,1] as a percentage label ("4.3%"); em-dash when null. */
export function scorePct(score: number | null | undefined, digits = 1): string {
  if (score == null) return "—";
  return `${(score * 100).toFixed(digits)}%`;
}

/** A step duration in ms as "240ms" / "1.2s". */
export function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
