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

/**
 * An attribution actor (an email or a sentinel like "ai") as a compact display label:
 * "ai" → "AI", an email → its local part ("mothil" from "mothil@datagenie.ai"). Pair
 * with the full value in a `title=` so the whole address is still recoverable on hover.
 * Empty/null → "" so callers can `&&`-guard rendering.
 */
export function formatActor(actor: string | null | undefined): string {
  if (!actor) return "";
  if (actor === "ai") return "AI";
  const at = actor.indexOf("@");
  return at > 0 ? actor.slice(0, at) : actor;
}

/**
 * How a run was triggered, as a person reads it. Two surfaces show this — the Runs list's Source
 * column and the run-detail header — and they must not disagree about what `varys` means.
 *
 * `varys` is an Agent Run Session that answered a Run Request pressed in the web app; `manual` is
 * a person starting an ordinary run themselves. Null is NOT "typed": it is every run recorded
 * before attribution existed, plus every one Varys never matched to a request of its own, so it
 * reads as the unremarkable default rather than as a claim about how it started.
 */
const RUN_SOURCE_LABEL: Record<string, string> = {
  manual: "Manual",
  schedule: "Scheduled",
  suite: "Suite",
  api: "API",
  // Varys' own re-run of a repaired test — neither a person's nor a cron's.
  repair: "Repair",
  // Someone pressed Run in Varys and their own Claude answered.
  varys: "From Varys",
};

/** A run's `triggerSource` as a display label; unknown and null both read "Manual". */
export function runSource(triggerSource: string | null | undefined): string {
  return RUN_SOURCE_LABEL[triggerSource ?? "manual"] ?? "Manual";
}

/**
 * How long is left on a deadline, as a compact label ("4m left", "under a minute left").
 *
 * For an Agent Run Session's Wall-Clock Lease in the runs list. Empty string once the deadline has
 * passed rather than "0m left" or a negative: an expired session is no longer counting down to
 * anything, and the row says `Failed` at that point — a stale countdown beside it would be the one
 * misreading worth avoiding.
 */
export function timeLeft(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ms = t - now;
  if (ms <= 0) return "";
  if (ms < MIN) return "under a minute left";
  if (ms < HOUR) return `${Math.round(ms / MIN)}m left`;
  return `${Math.round(ms / HOUR)}h left`;
}
