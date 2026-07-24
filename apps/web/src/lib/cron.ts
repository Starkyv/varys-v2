import type { TestSchedule, TestScheduleInput } from "@varys/review-contract";

/** The four scheduling cadences the editor offers; "custom" exposes the raw cron. */
export type Freq = "hourly" | "daily" | "weekly" | "custom";

export const FREQS: { value: Freq; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom" },
];

/** cron day-of-week is 0–6 (Sun–Sat). */
export const DOW_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
export const DOW_TITLES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const isNum = (x: string) => /^\d+$/.test(x);

/** Parse a 5-field cron into a cadence + its parameters (falls back to "custom"). */
export function parseCron(cron: string): { freq: Freq; minute: number; hour: number; days: number[] } {
  const f = cron.trim().split(/\s+/);
  if (f.length === 5) {
    const [m, h, dom, mon, dow] = f;
    const mn = isNum(m) ? Number(m) : null;
    const hn = isNum(h) ? Number(h) : null;
    if (mn != null && h === "*" && dom === "*" && mon === "*" && dow === "*")
      return { freq: "hourly", minute: mn, hour: 0, days: [] };
    if (mn != null && hn != null && dom === "*" && mon === "*" && dow === "*")
      return { freq: "daily", minute: mn, hour: hn, days: [] };
    if (mn != null && hn != null && dom === "*" && mon === "*" && /^[0-6](,[0-6])*$/.test(dow))
      return { freq: "weekly", minute: mn, hour: hn, days: dow.split(",").map(Number) };
  }
  return { freq: "custom", minute: 0, hour: 2, days: [1] };
}

/** Build a 5-field cron from a cadence + parameters. */
export function buildCron(
  freq: Freq,
  minute: number,
  hour: number,
  days: number[],
  custom: string,
): string {
  if (freq === "custom") return custom;
  if (freq === "hourly") return `${minute} * * * *`;
  if (freq === "daily") return `${minute} ${hour} * * *`;
  const d = (days.length ? [...days] : [1]).sort((a, b) => a - b).join(",");
  return `${minute} ${hour} * * ${d}`;
}

/** Plain-language summary of common cron expressions (display only — the server's
 *  cron-parser is the authoritative validator). Falls back to "Custom schedule". */
export function describeCron(cron: string): string {
  const map: Record<string, string> = {
    "0 * * * *": "Every hour, on the hour",
    "0 2 * * *": "Every day at 02:00",
    "0 8 * * 1-5": "Weekdays at 08:00",
    "0 9 * * 1": "Every Monday at 09:00",
    "*/15 * * * *": "Every 15 minutes",
    "*/5 * * * *": "Every 5 minutes",
  };
  return map[cron.trim()] ?? "Custom schedule";
}

/** A light client guard — the right field count. The server does the real parse and
 *  returns a 400 on a bad expression. */
export function cronShapeError(cron: string): string | null {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (cron.trim() === "") return "Enter a cron expression.";
  if (fields.length !== 5) return "A cron has 5 fields: min hour day-of-month month day-of-week.";
  return null;
}

/** "HH:MM" ⇄ {hour, minute}. */
export const toTime = (hour: number, minute: number) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
export const fromTime = (t: string): { hour: number; minute: number } => {
  const [h, m] = t.split(":").map((x) => Number(x));
  return { hour: Number.isFinite(h) ? h : 0, minute: Number.isFinite(m) ? m : 0 };
};

/** The live draft a {@link ScheduleEditor} reports up to its host. `error` is a client-side
 *  cron-shape guard (null = shape looks OK; the server still does the authoritative parse). */
export type ScheduleDraft = {
  enabled: boolean;
  cron: string;
  timezone: string;
  environmentId: string; // "" = default baseline
  keepTrace: boolean;
  error: string | null;
};

/** Turn a draft into the wire input the API expects under `schedule`. */
export function draftToInput(d: ScheduleDraft): TestScheduleInput {
  return {
    cron: d.cron.trim(),
    timezone: d.timezone.trim() || "UTC",
    enabled: d.enabled,
    environmentId: d.environmentId || null,
    keepTrace: d.keepTrace,
  };
}

/** Stable identity for a schedule, so a host card can remount (resetting draft state) when
 *  the server state changes after a save/remove. */
export function scheduleKey(s: TestSchedule | null): string {
  return s ? `s:${s.cron}|${s.timezone}|${s.enabled}|${s.environmentId}|${s.keepTrace}` : "s:none";
}
