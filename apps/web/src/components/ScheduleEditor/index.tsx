import type { TestSchedule } from "@varys/review-contract";
import { Clock, Input, SegmentedControl, Select, Switch } from "@varys/ui";
import { useEffect, useState } from "react";
import {
  buildCron,
  cronShapeError,
  describeCron,
  DOW_LABELS,
  DOW_TITLES,
  type Freq,
  FREQS,
  fromTime,
  parseCron,
  type ScheduleDraft,
  toTime,
} from "../../lib/cron";
import { absoluteTime, relativeTime } from "../../lib/format";
import { useEnvironments } from "../../queries";
import styles from "./styles.module.scss";

/**
 * The presentational schedule editor shared by the Test-detail and Suite editors: a cron cadence
 * builder (hourly / daily / weekly / custom) plus timezone, environment and keep-trace. It owns
 * its own draft state (seeded from `initialSchedule`) and reports the live {@link ScheduleDraft}
 * up via `onChange` — the host decides how to persist it (each editor wires its own mutation +
 * Save/Remove buttons). It renders the card head (title + on/off toggle) and body, but NOT the
 * surrounding Card or the action buttons.
 */
export function ScheduleEditor({
  initialSchedule,
  title,
  subtitle,
  onChange,
  collapseWhenOff = false,
}: {
  initialSchedule: TestSchedule | null;
  title: string;
  subtitle: string;
  onChange: (draft: ScheduleDraft) => void;
  /** When true, the cadence body is hidden while the schedule is off — the card stays a compact
   *  header-plus-toggle until the user turns it on. Defaults to false (body always shown, dimmed). */
  collapseWhenOff?: boolean;
}) {
  const environments = useEnvironments();

  const initial = parseCron(initialSchedule?.cron ?? "0 2 * * *");
  // Off by default: an entity with no schedule must start paused (an existing schedule keeps its
  // own enabled state).
  const [enabled, setEnabled] = useState(initialSchedule?.enabled ?? false);
  const [freq, setFreq] = useState<Freq>(initial.freq);
  const [minute, setMinute] = useState(initial.minute);
  const [hour, setHour] = useState(initial.hour);
  const [days, setDays] = useState<number[]>(initial.days.length ? initial.days : [1]);
  const [customCron, setCustomCron] = useState(initialSchedule?.cron ?? "0 2 * * *");
  const [timezone, setTimezone] = useState(initialSchedule?.timezone ?? "UTC");
  const [environmentId, setEnvironmentId] = useState(initialSchedule?.environmentId ?? "");
  const [keepTrace, setKeepTrace] = useState(initialSchedule?.keepTrace ?? false);

  // The effective cron is built from the cadence controls (or the raw field in Custom).
  const cron = buildCron(freq, minute, hour, days, customCron);
  const cronError = cronShapeError(cron);

  // Report the live draft up whenever any field changes.
  useEffect(() => {
    onChange({ enabled, cron, timezone, environmentId, keepTrace, error: cronError });
    // `onChange` is a stable setter from the host; cron/cronError are derived from the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cron, timezone, environmentId, keepTrace, cronError]);

  const cadence =
    freq === "hourly"
      ? `Every hour at :${String(minute).padStart(2, "0")}`
      : freq === "daily"
        ? `Every day at ${toTime(hour, minute)}`
        : freq === "weekly"
          ? `Weekly on ${(days.length ? [...days] : [1])
              .sort((a, b) => a - b)
              .map((d) => DOW_TITLES[d].slice(0, 3))
              .join(", ")} at ${toTime(hour, minute)}`
          : describeCron(cron);
  const envOptions = [
    { value: "", label: "— Default baseline —" },
    ...(environments.data ?? []).map((e) => ({ value: e.id, label: e.name })),
  ];
  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  return (
    <>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon}>
          <Clock size={15} />
        </span>
        <div className={styles.cardHeadText}>
          <div className={styles.cardTitle}>{title}</div>
          <div className={styles.cardSub}>{subtitle}</div>
        </div>
        <span className={styles.schedToggle}>
          <span className={styles.schedToggleLabel}>{enabled ? "On" : "Off"}</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable schedule" />
        </span>
      </div>

      {collapseWhenOff && !enabled ? null : (
      <div className={enabled ? styles.schedBody : styles.schedBodyOff}>
        {enabled && initialSchedule?.nextRunAt && (
          <div className={styles.nextRun}>
            <span className={styles.nextRunIcon}>
              <Clock size={15} />
            </span>
            <div className={styles.nextRunText}>
              <div className={styles.nextRunLabel}>Next run</div>
              <div className={styles.nextRunAbs}>{absoluteTime(initialSchedule.nextRunAt)}</div>
            </div>
            <span className={styles.nextRunRel}>{relativeTime(initialSchedule.nextRunAt)}</span>
          </div>
        )}

        <SegmentedControl<Freq> value={freq} onValueChange={setFreq} options={FREQS} />

        <div className={styles.schedContextual}>
          {freq === "hourly" && (
            <div className={styles.inlineRow}>
              <span>Run at minute</span>
              <Input
                inputSize="sm"
                mono
                type="number"
                min={0}
                max={59}
                className={styles.minuteInput}
                aria-label="Minute of the hour"
                value={String(minute)}
                onChange={(e) => setMinute(Number(e.target.value) || 0)}
              />
              <span className={styles.muted}>of every hour</span>
            </div>
          )}
          {freq === "daily" && (
            <div className={styles.inlineRow}>
              <span>Run every day at</span>
              <Input
                inputSize="sm"
                mono
                type="time"
                aria-label="Time of day"
                value={toTime(hour, minute)}
                onChange={(e) => {
                  const t = fromTime(e.target.value);
                  setHour(t.hour);
                  setMinute(t.minute);
                }}
              />
            </div>
          )}
          {freq === "weekly" && (
            <>
              <div className={styles.dayPills}>
                {DOW_LABELS.map((lbl, d) => (
                  <button
                    key={DOW_TITLES[d]}
                    type="button"
                    title={DOW_TITLES[d]}
                    className={`${styles.dayPill} ${days.includes(d) ? styles.dayPillOn : ""}`}
                    onClick={() => toggleDay(d)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <div className={styles.inlineRow}>
                <span>at</span>
                <Input
                  inputSize="sm"
                  mono
                  type="time"
                  aria-label="Time of day"
                  value={toTime(hour, minute)}
                  onChange={(e) => {
                    const t = fromTime(e.target.value);
                    setHour(t.hour);
                    setMinute(t.minute);
                  }}
                />
              </div>
            </>
          )}
          {freq === "custom" && (
            <label className={styles.schedField}>
              <span className={styles.schedLabel}>Cron expression</span>
              <Input
                inputSize="sm"
                mono
                spellCheck={false}
                value={customCron}
                invalid={!!cronError}
                aria-label="Cron expression"
                onChange={(e) => setCustomCron(e.target.value)}
              />
            </label>
          )}
        </div>

        <div className={`${styles.schedSummary} ${cronError ? styles.schedSummaryError : ""}`}>
          <span>{cronError ?? cadence}</span>
          <span className={styles.cronReadout}>{cron}</span>
        </div>

        <div className={styles.schedGrid}>
          <label className={styles.schedField}>
            <span className={styles.schedLabel}>Timezone</span>
            <Input
              inputSize="sm"
              mono
              value={timezone}
              placeholder="UTC"
              aria-label="Timezone"
              onChange={(e) => setTimezone(e.target.value)}
            />
          </label>
          <label className={styles.schedField}>
            <span className={styles.schedLabel}>Environment</span>
            <Select
              ariaLabel="Environment"
              selectSize="sm"
              value={environmentId}
              onValueChange={setEnvironmentId}
              options={envOptions}
            />
          </label>
        </div>

        <label className={styles.schedTraceField}>
          <Switch
            checked={keepTrace}
            onCheckedChange={setKeepTrace}
            aria-label="Keep a Playwright trace on scheduled runs"
          />
          <span>
            <span className={styles.schedTraceTitle}>Keep trace</span>
            <span className={styles.schedTraceHint}>Capture a Playwright trace each run</span>
          </span>
        </label>
      </div>
      )}
    </>
  );
}
