import type {
  ConfigWait,
  EditableWait,
  TestConfigPatch,
  TestConfigStep,
  TestConfigStepPatch,
  TestConfigView,
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
  Plus,
  Skeleton,
  Sliders,
} from "@varys/ui";
import { useState } from "react";
import { useRouter } from "../../context/router";
import { useToast } from "../../context/toast";
import { useSaveTestConfig, useTestConfig } from "../../queries";
import styles from "./styles.module.scss";

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
  const { toast } = useToast();
  const save = useSaveTestConfig(config.id);

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
  const anyInvalid = config.steps.some(thresholdInvalid);
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
      </div>

      <Card>
        <div className={styles.cardHead}>
          <span className={styles.cardIcon}>
            <Sliders size={15} />
          </span>
          <div>
            <div className={styles.cardTitle}>Default waits</div>
            <div className={styles.cardSub}>
              Applied before every step that supports waits (clicks, typing, checkpoints — not the
              opening navigation), ahead of each step’s own waits.
            </div>
          </div>
        </div>
        <WaitListEditor
          waits={defaultWaits}
          locked={initialDefaults.locked}
          onChange={setDefaultWaits}
          emptyHint="No default waits. Add one to settle the page before every step."
        />
      </Card>

      <Card>
        <div className={styles.cardHead}>
          <span className={styles.cardIcon}>
            <Eye size={15} />
          </span>
          <div>
            <div className={styles.cardTitle}>Steps</div>
            <div className={styles.cardSub}>
              Per-step waits layer on top of the defaults. Thresholds apply to that checkpoint only.
            </div>
          </div>
        </div>
        <div className={styles.steps}>
          {config.steps.map((s, i) => {
            const Icon = STEP_ICON[s.type];
            const locked = splitWaits(s.waitBefore).locked;
            return (
              <div key={s.index} className={styles.step}>
                <div className={styles.stepHead}>
                  <span className={styles.stepIcon}>
                    <Icon size={14} />
                  </span>
                  <span className={styles.stepLabel}>{s.label}</span>
                  {s.type === "screenshot" && s.captureMode && (
                    <span className={styles.stepTag}>{s.captureMode}</span>
                  )}
                </div>

                {s.supportsWaits ? (
                  <WaitListEditor
                    waits={stepWaits[i]}
                    locked={locked}
                    onChange={(next) => setStepWait(i, next)}
                    emptyHint="No waits on this step (defaults still apply)."
                  />
                ) : (
                  <div className={styles.stepNote}>Navigation waits for network idle automatically.</div>
                )}

                {s.type === "screenshot" && (
                  <div className={styles.thresholdRow}>
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
                      {thresholdInvalid(s) ? "Enter a value between 0 and 1" : "max mismatched-pixel ratio (0–1)"}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <div className={styles.saveBar}>
        <span className={styles.saveHint}>
          {patch ? "Saving writes a new test version — it applies on the next run." : "No changes yet."}
        </span>
        <Button variant="primary" loading={save.isPending} disabled={!canSave} onClick={onSave}>
          Save changes
        </Button>
      </div>
    </div>
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
        <div key={`locked-${i}`} className={styles.waitRow}>
          <span className={styles.waitKind}>
            <Lock size={13} /> Wait for {w.targetLabel} {w.state}
          </span>
          <span className={styles.waitLockedNote}>recorded — kept on save</span>
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
          <IconButton
            variant="ghost"
            size="sm"
            icon={<Plus style={{ transform: "rotate(45deg)" }} />}
            label="Remove wait"
            onClick={() => remove(i)}
          />
        </div>
      ))}

      {locked.length === 0 && waits.length === 0 && <div className={styles.waitEmpty}>{emptyHint}</div>}

      <div className={styles.waitAdd}>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Activity size={13} />}
          onClick={() => onChange([...waits, { kind: "networkIdle", timeoutMs: 10000 }])}
        >
          Network idle
        </Button>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Clock size={13} />}
          onClick={() => onChange([...waits, { kind: "delay", ms: 500 }])}
        >
          Delay
        </Button>
      </div>
    </div>
  );
}
