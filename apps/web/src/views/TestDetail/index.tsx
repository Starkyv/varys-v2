import type {
  ConfigWait,
  EditableWait,
  TestConfigPatch,
  TestConfigStep,
  TestConfigStepPatch,
  TestConfigView,
  TestSchedule,
} from "@varys/review-contract";
import {
  Activity,
  ArrowLeft,
  Badge,
  Button,
  Card,
  Clock,
  ErrorState,
  ExternalLink,
  Eye,
  IconButton,
  Input,
  Lock,
  Pencil,
  Play,
  Select,
  SegmentedControl,
  Skeleton,
  Sliders,
  Switch,
  Trash,
} from "@varys/ui";
import { useState } from "react";
import { useRouter } from "../../context/router";
import { useRunDialog } from "../../context/run-dialog";
import { useToast } from "../../context/toast";
import { absoluteTime, relativeTime } from "../../lib/format";
import { useEnvironments, useSaveTestConfig, useTestConfig, useUpdateTest } from "../../queries";
import styles from "./styles.module.scss";

/** Plain-language summary of common cron expressions (display only — the server's
 *  cron-parser is the authoritative validator). Falls back to "Custom schedule". */
function describeCron(cron: string): string {
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
function cronShapeError(cron: string): string | null {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (cron.trim() === "") return "Enter a cron expression.";
  if (fields.length !== 5) return "A cron has 5 fields: min hour day-of-month month day-of-week.";
  return null;
}

/** Stable identity for a schedule, so the card remounts (resetting its draft state) when
 *  the server state changes after a save/remove. */
function scheduleKey(s: TestSchedule | null): string {
  return s ? `s:${s.cron}|${s.timezone}|${s.enabled}|${s.environmentId}|${s.keepTrace}` : "s:none";
}

type LockedWait = Extract<ConfigWait, { kind: "selector" }>;

/** Split a step's waits into the selector waits (display-only, preserved on save) and
 *  the delay/networkIdle waits the editor manages. */
function splitWaits(waits: ConfigWait[]): { locked: LockedWait[]; editable: EditableWait[] } {
  const locked: LockedWait[] = [];
  const editable: EditableWait[] = [];
  for (const w of waits) {
    if (w.kind === "selector") locked.push(w);
    else editable.push(w);
  }
  return { locked, editable };
}

const STEP_ICON: Record<TestConfigStep["type"], typeof Eye> = {
  navigate: ExternalLink,
  click: Activity,
  type: Pencil,
  screenshot: Eye,
};

/** The four scheduling cadences the editor offers; "custom" exposes the raw cron. */
type Freq = "hourly" | "daily" | "weekly" | "custom";

/** cron day-of-week is 0–6 (Sun–Sat). */
const DOW_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DOW_TITLES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const isNum = (x: string) => /^\d+$/.test(x);

/** Parse a 5-field cron into a cadence + its parameters (falls back to "custom"). */
function parseCron(cron: string): { freq: Freq; minute: number; hour: number; days: number[] } {
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
function buildCron(freq: Freq, minute: number, hour: number, days: number[], custom: string): string {
  if (freq === "custom") return custom;
  if (freq === "hourly") return `${minute} * * * *`;
  if (freq === "daily") return `${minute} ${hour} * * *`;
  const d = (days.length ? [...days] : [1]).sort((a, b) => a - b).join(",");
  return `${minute} ${hour} * * ${d}`;
}

/** "HH:MM" ⇄ {hour, minute}. */
const toTime = (hour: number, minute: number) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
const fromTime = (t: string): { hour: number; minute: number } => {
  const [h, m] = t.split(":").map((x) => Number(x));
  return { hour: Number.isFinite(h) ? h : 0, minute: Number.isFinite(m) ? m : 0 };
};

export function TestDetail({ testId }: { testId: string }) {
  const { navigate } = useRouter();
  const config = useTestConfig(testId);

  if (config.isLoading) {
    return (
      <div className={styles.page}>
        <Skeleton height={64} radius="var(--radius-xl)" />
        <Skeleton height={140} radius="var(--radius-xl)" />
        <Skeleton height={320} radius="var(--radius-xl)" />
      </div>
    );
  }
  if (config.isError || !config.data) {
    return (
      <div className={styles.page}>
        <ErrorState title="Couldn’t load this test" onRetry={() => config.refetch()} />
        <div className={styles.header}>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<ArrowLeft size={14} />}
            onClick={() => navigate({ name: "tests" })}
          >
            Back to tests
          </Button>
        </div>
      </div>
    );
  }

  // Key by version so a successful save (which bumps the version) remounts the editor
  // with fresh data, clearing the dirty state.
  return <ConfigEditor key={`${config.data.id}:${config.data.version}`} config={config.data} />;
}

function ConfigEditor({ config }: { config: TestConfigView }) {
  const { navigate } = useRouter();
  const { openRunDialog } = useRunDialog();
  const { toast } = useToast();
  const save = useSaveTestConfig(config.id);

  const checkpointCount = config.steps.filter((s) => s.type === "screenshot").length;

  const initialDefaults = splitWaits(config.defaults);
  const initialStepEditable = config.steps.map((s) => splitWaits(s.waitBefore).editable);

  const [defaultWaits, setDefaultWaits] = useState<EditableWait[]>(initialDefaults.editable);
  const [stepWaits, setStepWaits] = useState<EditableWait[][]>(initialStepEditable);
  const [thresholds, setThresholds] = useState<Record<number, string>>(() => {
    const m: Record<number, string> = {};
    for (const s of config.steps) {
      if (s.type === "screenshot") m[s.index] = s.threshold != null ? String(s.threshold) : "";
    }
    return m;
  });

  // Steps marked for removal (by definition index). Applied on save; the entry
  // navigation (index 0) can't be removed and never offers the control.
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  function toggleRemove(index: number) {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function setStepWait(i: number, next: EditableWait[]) {
    setStepWaits((prev) => prev.map((w, idx) => (idx === i ? next : w)));
  }

  const initialThreshold = (s: TestConfigStep) =>
    s.type === "screenshot" && s.threshold != null ? String(s.threshold) : "";

  function thresholdInvalid(s: TestConfigStep): boolean {
    if (s.type !== "screenshot") return false;
    const v = (thresholds[s.index] ?? "").trim();
    if (v === "") return false; // empty = leave unchanged (not an error)
    const n = Number(v);
    return !Number.isFinite(n) || n <= 0 || n > 1;
  }

  // Build the minimal patch from what actually changed (null when nothing did).
  function buildPatch(): TestConfigPatch | null {
    const defaultsChanged =
      JSON.stringify(defaultWaits) !== JSON.stringify(initialDefaults.editable);

    const steps: TestConfigStepPatch[] = [];
    config.steps.forEach((s, i) => {
      if (removed.has(s.index)) {
        steps.push({ index: s.index, remove: true });
        return;
      }
      if (s.type === "navigate") return;
      const waitsChanged = JSON.stringify(stepWaits[i]) !== JSON.stringify(initialStepEditable[i]);
      const cur = (thresholds[s.index] ?? "").trim();
      const thresholdChanged =
        s.type === "screenshot" && cur !== "" && cur !== initialThreshold(s) && !thresholdInvalid(s);
      if (!waitsChanged && !thresholdChanged) return;
      const p: TestConfigStepPatch = { index: s.index };
      if (waitsChanged) p.waitBefore = stepWaits[i];
      if (thresholdChanged) p.threshold = Number(cur);
      steps.push(p);
    });

    if (!defaultsChanged && steps.length === 0) return null;
    const patch: TestConfigPatch = { baseVersion: config.version };
    if (defaultsChanged) patch.defaults = defaultWaits;
    if (steps.length > 0) patch.steps = steps;
    return patch;
  }

  const patch = buildPatch();
  // A removed step's threshold can't block the save.
  const anyInvalid = config.steps.some((s) => !removed.has(s.index) && thresholdInvalid(s));
  const canSave = patch !== null && !anyInvalid && !save.isPending;

  function onSave() {
    if (!patch) return;
    save.mutate(patch, {
      onSuccess: (res) => toast(`Saved — “${config.name}” is now v${res.version}`),
      onError: (e) => toast(e instanceof Error ? e.message : "Save failed"),
    });
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <IconButton
          variant="ghost"
          size="sm"
          icon={<ArrowLeft />}
          label="Back to tests"
          onClick={() => navigate({ name: "tests" })}
        />
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{config.name}</h1>
          <Badge tone="neutral" appearance="soft" size="sm">
            v{config.version}
          </Badge>
        </div>
        <span className={styles.headerSpacer} />
        <Button variant="secondary" iconLeft={<Play size={14} />} onClick={() => openRunDialog(config.id)}>
          Run now
        </Button>
      </div>

      <div className={styles.contextStrip}>
        <span className={styles.ctxItem}>
          <strong>{checkpointCount}</strong> checkpoint{checkpointCount === 1 ? "" : "s"}
        </span>
        <span className={styles.ctxDot} />
        <span className={styles.ctxItem}>
          <strong>{config.steps.length}</strong> step{config.steps.length === 1 ? "" : "s"}
        </span>
        {config.schedule?.enabled && config.schedule.nextRunAt && (
          <>
            <span className={styles.ctxDot} />
            <span className={styles.ctxItem}>
              <Clock size={13} /> next run {relativeTime(config.schedule.nextRunAt)}
            </span>
          </>
        )}
      </div>

      <div className={styles.grid}>
        <div className={styles.rail}>
          <ScheduleCard
            key={scheduleKey(config.schedule)}
            testId={config.id}
            schedule={config.schedule}
          />

          <Card>
            <div className={styles.cardHead}>
              <span className={styles.cardIcon}>
                <Sliders size={15} />
              </span>
          <div className={styles.cardHeadText}>
            <div className={styles.cardTitle}>Default waits</div>
            <div className={styles.cardSub}>
              Run before every step that supports waits — clicks, typing, checkpoints (not the
              opening navigation) — ahead of each step’s own waits.
            </div>
          </div>
        </div>
            <WaitListEditor
              waits={defaultWaits}
              locked={initialDefaults.locked}
              onChange={setDefaultWaits}
              emptyHint="None yet — add one to settle every step."
            />
          </Card>
        </div>

        <div className={styles.main}>
          <Card>
            <div className={styles.cardHead}>
              <span className={styles.cardIcon}>
                <Eye size={15} />
              </span>
          <div className={styles.cardHeadText}>
            <div className={styles.cardTitle}>Steps</div>
            <div className={styles.cardSub}>
              Per-step waits layer on top of the defaults. Thresholds apply to that checkpoint only.
            </div>
          </div>
          <span className={styles.cardCount}>
            {config.steps.length} step{config.steps.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className={styles.steps}>
          {config.steps.map((s, i) => {
            const Icon = STEP_ICON[s.type];
            const locked = splitWaits(s.waitBefore).locked;
            const isLast = i === config.steps.length - 1;
            const isRemoved = removed.has(s.index);
            const canRemove = s.index !== 0; // the entry navigation is structural
            return (
              <div
                key={s.index}
                className={`${styles.step} ${isLast ? styles.stepLast : ""} ${isRemoved ? styles.stepRemoved : ""}`}
              >
                <div className={styles.stepRail}>
                  <span className={styles.stepNum}>{i + 1}</span>
                </div>
                <div className={styles.stepBody}>
                  <div className={styles.stepHead}>
                    <span className={styles.stepIcon}>
                      <Icon size={14} />
                    </span>
                    <span className={styles.stepLabel}>{s.label}</span>
                    {s.type === "screenshot" && s.captureMode && (
                      <span className={styles.stepTag}>{s.captureMode}</span>
                    )}
                    <span className={styles.stepHeadSpacer} />
                    {isRemoved ? (
                      <Button variant="ghost" size="sm" onClick={() => toggleRemove(s.index)}>
                        Undo
                      </Button>
                    ) : (
                      canRemove && (
                        <IconButton
                          variant="ghost"
                          size="sm"
                          icon={<Trash size={14} />}
                          label={`Remove step ${i + 1}`}
                          className={styles.stepRemove}
                          onClick={() => toggleRemove(s.index)}
                        />
                      )
                    )}
                  </div>

                  {isRemoved ? (
                    <div className={styles.stepNote}>Removed — saving writes a new version without this step.</div>
                  ) : (
                    <>
                      {s.supportsWaits ? (
                        <WaitListEditor
                          waits={stepWaits[i]}
                          locked={locked}
                          onChange={(next) => setStepWait(i, next)}
                          emptyHint="Only the test defaults run here."
                        />
                      ) : (
                        <div className={styles.stepNote}>Navigation settles on network idle automatically.</div>
                      )}

                      {s.type === "screenshot" && (
                        <div className={`${styles.thresholdRow} ${thresholdInvalid(s) ? styles.thresholdRowError : ""}`}>
                          <Sliders size={13} />
                          <span className={styles.thresholdLabel}>Diff threshold</span>
                          <Input
                            inputSize="sm"
                            mono
                            type="number"
                            min={0}
                            max={1}
                            step={0.01}
                            placeholder="0.01"
                            aria-label={`Threshold for ${s.checkpointName ?? "checkpoint"}`}
                            invalid={thresholdInvalid(s)}
                            className={styles.thresholdInput}
                            value={thresholds[s.index] ?? ""}
                            onChange={(e) =>
                              setThresholds((prev) => ({ ...prev, [s.index]: e.target.value }))
                            }
                          />
                          <span className={styles.thresholdHelp}>
                            {thresholdInvalid(s)
                              ? "Enter a value between 0 and 1"
                              : "max mismatched-pixel ratio · blank = default 0.01"}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
            </div>
          </Card>
        </div>
      </div>

      <div className={styles.saveBar}>
        <span className={styles.saveHint}>
          {patch
            ? removed.size > 0
              ? `Saving writes a new version, removing ${removed.size} step${removed.size === 1 ? "" : "s"} — it applies on the next run.`
              : "Saving writes a new test version — it applies on the next run."
            : "No changes yet."}
        </span>
        <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={onSave}>
          Save changes
        </Button>
      </div>
    </div>
  );
}

/**
 * The test's cron schedule (Slice 8) — its own card with its own save (the structural
 * PATCH /tests/:id, NOT the versioned config save). The toggle gates firing; cron +
 * timezone set the cadence, with an optional environment + keep-trace. A scheduled run
 * is an ordinary run (it only fires once the scheduler tick ships — PRD 1, Issue 2).
 */
function ScheduleCard({ testId, schedule }: { testId: string; schedule: TestSchedule | null }) {
  const { toast } = useToast();
  const environments = useEnvironments();
  const update = useUpdateTest();

  const initial = parseCron(schedule?.cron ?? "0 2 * * *");
  // Off by default: a test with no schedule must start paused (an existing schedule keeps
  // its own enabled state). Defaulting to `true` here turned scheduling on for every new test.
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [freq, setFreq] = useState<Freq>(initial.freq);
  const [minute, setMinute] = useState(initial.minute);
  const [hour, setHour] = useState(initial.hour);
  const [days, setDays] = useState<number[]>(initial.days.length ? initial.days : [1]);
  const [customCron, setCustomCron] = useState(schedule?.cron ?? "0 2 * * *");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? "UTC");
  const [environmentId, setEnvironmentId] = useState(schedule?.environmentId ?? "");
  const [keepTrace, setKeepTrace] = useState(schedule?.keepTrace ?? false);

  // The effective cron is built from the cadence controls (or the raw field in Custom).
  const cron = buildCron(freq, minute, hour, days, customCron);
  const cronError = cronShapeError(cron);
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
  const FREQS: { value: Freq; label: string }[] = [
    { value: "hourly", label: "Hourly" },
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
    { value: "custom", label: "Custom" },
  ];
  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  function onSave() {
    if (cronError) return;
    update.mutate(
      {
        id: testId,
        body: {
          schedule: {
            cron: cron.trim(),
            timezone: timezone.trim() || "UTC",
            enabled,
            environmentId: environmentId || null,
            keepTrace,
          },
        },
      },
      {
        onSuccess: () => toast(enabled ? "Schedule saved" : "Schedule saved — paused"),
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t save the schedule"),
      },
    );
  }

  function onRemove() {
    update.mutate(
      { id: testId, body: { schedule: null } },
      {
        onSuccess: () => toast("Schedule removed"),
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t remove the schedule"),
      },
    );
  }

  return (
    <Card>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon}>
          <Clock size={15} />
        </span>
        <div className={styles.cardHeadText}>
          <div className={styles.cardTitle}>Schedule</div>
          <div className={styles.cardSub}>
            Run this test automatically on a cron. Off by default; a scheduled run lands in Runs
            and Needs Review exactly like a manual one.
          </div>
        </div>
        <span className={styles.schedToggle}>
          <span className={styles.schedToggleLabel}>{enabled ? "On" : "Off"}</span>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable schedule" />
        </span>
      </div>

      <div className={enabled ? styles.schedBody : styles.schedBodyOff}>
        {enabled && schedule?.nextRunAt && (
          <div className={styles.nextRun}>
            <span className={styles.nextRunIcon}>
              <Clock size={15} />
            </span>
            <div className={styles.nextRunText}>
              <div className={styles.nextRunLabel}>Next run</div>
              <div className={styles.nextRunAbs}>{absoluteTime(schedule.nextRunAt)}</div>
            </div>
            <span className={styles.nextRunRel}>{relativeTime(schedule.nextRunAt)}</span>
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

      <div className={styles.schedActions}>
        {schedule && (
          <Button variant="ghost" size="sm" disabled={update.isPending} onClick={onRemove}>
            Remove schedule
          </Button>
        )}
        <span className={styles.schedActionsSpacer} />
        <Button
          variant="primary"
          size="sm"
          disabled={!!cronError || update.isPending}
          loading={update.isPending}
          onClick={onSave}
        >
          Save schedule
        </Button>
      </div>
    </Card>
  );
}

/** Editor for a list of delay/networkIdle waits, with any selector waits shown as
 *  read-only locked rows (preserved on save). */
function WaitListEditor({
  waits,
  locked,
  onChange,
  emptyHint,
}: {
  waits: EditableWait[];
  locked: LockedWait[];
  onChange: (next: EditableWait[]) => void;
  emptyHint: string;
}) {
  function update(i: number, next: EditableWait) {
    onChange(waits.map((w, idx) => (idx === i ? next : w)));
  }
  function remove(i: number) {
    onChange(waits.filter((_, idx) => idx !== i));
  }

  return (
    <div className={styles.waits}>
      {locked.map((w, i) => (
        <div key={`locked-${i}`} className={`${styles.waitRow} ${styles.lockedRow}`}>
          <span className={styles.waitKind}>
            <Lock size={13} />
            <span className={styles.lockedText}>
              Wait for {w.targetLabel} {w.state}
            </span>
          </span>
          <span className={styles.waitLockedNote}>recorded · kept on save</span>
        </div>
      ))}

      {waits.map((w, i) => (
        <div key={i} className={styles.waitRow}>
          <span className={styles.waitKind}>
            {w.kind === "networkIdle" ? <Activity size={13} /> : <Clock size={13} />}
            {w.kind === "networkIdle" ? "Network idle" : "Delay"}
          </span>
          <Input
            inputSize="sm"
            mono
            type="number"
            min={w.kind === "networkIdle" ? 1 : 0}
            step={100}
            className={styles.waitInput}
            aria-label={w.kind === "networkIdle" ? "Network-idle timeout (ms)" : "Delay (ms)"}
            value={String(w.kind === "networkIdle" ? (w.timeoutMs ?? 10000) : w.ms)}
            onChange={(e) => {
              const raw = Math.floor(Number(e.target.value));
              if (w.kind === "networkIdle") {
                update(i, { kind: "networkIdle", timeoutMs: Number.isFinite(raw) ? Math.max(1, raw) : 1 });
              } else {
                update(i, { kind: "delay", ms: Number.isFinite(raw) ? Math.max(0, raw) : 0 });
              }
            }}
          />
          <span className={styles.waitUnit}>ms</span>
          <button type="button" className={styles.waitRemove} aria-label="Remove wait" onClick={() => remove(i)}>
            ×
          </button>
        </div>
      ))}

      <div className={styles.waitAdd}>
        <button
          type="button"
          className={styles.addChip}
          onClick={() => onChange([...waits, { kind: "networkIdle", timeoutMs: 10000 }])}
        >
          <Activity size={13} /> Network idle
        </button>
        <button
          type="button"
          className={styles.addChip}
          onClick={() => onChange([...waits, { kind: "delay", ms: 500 }])}
        >
          <Clock size={13} /> Delay
        </button>
        {locked.length === 0 && waits.length === 0 && (
          <span className={styles.waitEmpty}>{emptyHint}</span>
        )}
      </div>
    </div>
  );
}
