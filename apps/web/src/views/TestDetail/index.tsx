import type {
  CompareMode,
  ConfigWait,
  EditableWait,
  EnvironmentView,
  FingerprintPatch,
  LocatorVerifyResult,
  NewStepInput,
  Rect,
  TestConfigPatch,
  TestConfigStep,
  TestConfigStepInsert,
  TestConfigStepPatch,
  TestConfigView,
  TestSchedule,
} from "@varys/review-contract";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Badge,
  Button,
  Camera,
  Card,
  Check,
  Clock,
  ErrorState,
  ExternalLink,
  Eye,
  IconButton,
  ImageOff,
  Input,
  Lock,
  MousePointer,
  Pencil,
  Play,
  Plus,
  Select,
  SegmentedControl,
  type SegmentedOption,
  Skeleton,
  Sliders,
  Trash,
} from "@varys/ui";
import { type KeyboardEvent as ReactKeyboardEvent, useRef, useState } from "react";
import { NotesCard } from "../../components/NotesCard";
import { ScheduleEditor } from "../../components/ScheduleEditor";
import { BaselineMaskCanvas } from "./components/BaselineMaskCanvas";
import { useRouter } from "../../context/router";
import { useRunDialog } from "../../context/run-dialog";
import { useToast } from "../../context/toast";
import { draftToInput, scheduleKey, type ScheduleDraft } from "../../lib/cron";
import { relativeTime } from "../../lib/format";
import { StatusBadge } from "../../lib/status";
import {
  useEnvironments,
  useSaveTestConfig,
  useTestConfig,
  useTestRuns,
  useUpdateTest,
  useVerifyLocator,
} from "../../queries";
import styles from "./styles.module.scss";

type LockedWait = Extract<ConfigWait, { kind: "selector" }>;

/** The editable locator signals for one step, as draft strings ("" = absent/cleared). */
type LocatorDraft = {
  role: string;
  accessibleName: string;
  text: string;
  testId: string;
  selectorOverride: string;
};
const LOCATOR_FIELDS = ["role", "accessibleName", "text", "testId", "selectorOverride"] as const;

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
  hover: MousePointer,
  type: Pencil,
  screenshot: Eye,
};

/** A manually-added step held in the editor until Save, anchored to an existing step. */
type StagedInsert = {
  tempId: string;
  atIndex: number;
  position: "above" | "below";
  step: NewStepInput;
};

/** Icon per manually-addable step type (kept consistent between the picker and the staged row). */
const NEW_STEP_ICON: Record<NewStepInput["type"], typeof Eye> = {
  navigate: ExternalLink,
  screenshot: Eye,
  click: MousePointer,
  type: Pencil,
};

/** Human label for a staged insert row (mirrors the run timeline's vocabulary). */
function newStepLabel(step: NewStepInput): string {
  switch (step.type) {
    case "navigate":
      return `Navigate to ${step.url}`;
    case "screenshot":
      return `Checkpoint “${step.name}” · full page`;
    case "click":
      return `Click ${step.selector}`;
    default:
      return step.value ? `Type “${step.value}” into ${step.selector}` : `Type into ${step.selector}`;
  }
}

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
  const notesUpdate = useUpdateTest();

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

  // Per-checkpoint mask regions, seeded from the read-model; edited by drawing on the baseline.
  const initialMasksByIndex: Record<number, Rect[]> = {};
  for (const s of config.steps) {
    if (s.type === "screenshot") initialMasksByIndex[s.index] = s.masks;
  }
  const [masksByIndex, setMasksByIndex] = useState<Record<number, Rect[]>>(initialMasksByIndex);
  function setStepMasks(index: number, next: Rect[]) {
    setMasksByIndex((prev) => ({ ...prev, [index]: next }));
  }

  // Per-checkpoint comparison mode (pixel diff vs. context/LLM judge) + the judge prompt,
  // seeded from the read-model. `context` swaps the pixel-diff knobs (threshold/masks) for the
  // prompt below.
  const initialCompareModes: Record<number, CompareMode> = {};
  const initialPrompts: Record<number, string> = {};
  for (const s of config.steps) {
    if (s.type === "screenshot") {
      initialCompareModes[s.index] = s.compareMode ?? "pixel";
      initialPrompts[s.index] = s.prompt ?? "";
    }
  }
  const [compareModes, setCompareModes] = useState<Record<number, CompareMode>>(initialCompareModes);
  const [prompts, setPrompts] = useState<Record<number, string>>(initialPrompts);
  // A context checkpoint's prompt is OPTIONAL — when blank it inherits the global default judge
  // prompt from the Configurations page. So it never blocks a save.
  function contextPromptInvalid(_s: TestConfigStep): boolean {
    return false;
  }

  // Per-step typed value (type steps only), seeded from the read-model — an editable literal.
  const initialValues: Record<number, string> = {};
  for (const s of config.steps) {
    if (s.type === "type") initialValues[s.index] = s.value ?? "";
  }
  const [typedValues, setTypedValues] = useState<Record<number, string>>(initialValues);
  function setTypedValue(index: number, v: string) {
    setTypedValues((prev) => ({ ...prev, [index]: v }));
  }

  // Per-step editable locator signals, seeded from the read-model. Only steps with an
  // element target (click / type / element-mode screenshot) get an entry.
  const initialTargets: Record<number, LocatorDraft> = {};
  for (const s of config.steps) {
    if (s.target) {
      initialTargets[s.index] = {
        role: s.target.role ?? "",
        accessibleName: s.target.accessibleName ?? "",
        text: s.target.text ?? "",
        testId: s.target.testId ?? "",
        selectorOverride: s.target.selectorOverride ?? "",
      };
    }
  }
  const [targets, setTargets] = useState<Record<number, LocatorDraft>>(initialTargets);
  function setTargetField(index: number, field: keyof LocatorDraft, value: string) {
    setTargets((prev) => ({ ...prev, [index]: { ...prev[index], [field]: value } }));
    // A locator edit invalidates that step's last verdict — clear it so we never show stale.
    setVerdicts((prev) => {
      if (!(index in prev)) return prev;
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }

  // Live locator verify (Slice 16.3b). The env picker mirrors the Run pre-flight: required
  // (with a satisfied-check) when the test declares variables; absent for a no-variable test.
  const environments = useEnvironments();
  const verifyMut = useVerifyLocator(config.id);
  const [verifyEnvId, setVerifyEnvId] = useState<string>("");
  const [verdicts, setVerdicts] = useState<Record<number, LocatorVerifyResult>>({});
  const [verifyingStep, setVerifyingStep] = useState<number | null>(null);

  const envList = environments.data ?? [];
  const selectedEnv: EnvironmentView | undefined = verifyEnvId
    ? envList.find((e) => e.id === verifyEnvId)
    : undefined;
  // Can't verify until a needed environment is chosen (it supplies {{baseUrl}} + cookies/localStorage).
  const canVerify = (!config.needsEnvironment || !!selectedEnv) && verifyingStep === null;

  function onVerify(stepIndex: number) {
    const td = targets[stepIndex];
    if (!td) return;
    // Send the CURRENT (unsaved) draft for every editable signal so the server's merge
    // reproduces exactly the candidate a save would write ("" clears a signal).
    const target: FingerprintPatch = {
      role: td.role,
      accessibleName: td.accessibleName,
      text: td.text,
      testId: td.testId,
      selectorOverride: td.selectorOverride,
    };
    setVerifyingStep(stepIndex);
    verifyMut.mutate(
      { stepIndex, environmentId: verifyEnvId || undefined, target },
      {
        onSuccess: (res) => setVerdicts((prev) => ({ ...prev, [stepIndex]: res })),
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t verify the locator"),
        onSettled: () => setVerifyingStep(null),
      },
    );
  }

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

  // Manually added steps, staged until Save (Navigate or full-page Checkpoint). Each is anchored
  // to an existing step's original index + side; the entry navigation (index 0) takes no "above".
  const [inserts, setInserts] = useState<StagedInsert[]>([]);
  // Which gap's add-form is open, and the in-progress field values for it.
  const [draft, setDraft] = useState<{ atIndex: number; position: "above" | "below" } | null>(null);
  const [draftType, setDraftType] = useState<NewStepInput["type"]>("screenshot");
  const [draftUrl, setDraftUrl] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftSelector, setDraftSelector] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const insertId = useRef(0);

  function openInsert(atIndex: number, position: "above" | "below") {
    setDraft({ atIndex, position });
    setDraftType("screenshot");
    setDraftUrl("");
    setDraftName("");
    setDraftSelector("");
    setDraftValue("");
  }
  function cancelInsert() {
    setDraft(null);
  }
  function removeInsert(tempId: string) {
    setInserts((prev) => prev.filter((x) => x.tempId !== tempId));
  }

  // Checkpoint names must be unique (they're the baseline key) — gather the names already in use
  // (recorded + staged) so the add-form can reject a duplicate before it's saved.
  const existingNames = new Set(
    config.steps.filter((s) => s.type === "screenshot" && s.checkpointName).map((s) => s.checkpointName as string),
  );
  const stagedNames = inserts
    .filter((x) => x.step.type === "screenshot")
    .map((x) => (x.step as Extract<NewStepInput, { type: "screenshot" }>).name);
  const allNames = new Set<string>([...existingNames, ...stagedNames]);

  const draftNameTrim = draftName.trim();
  const draftUrlTrim = draftUrl.trim();
  const draftSelectorTrim = draftSelector.trim();
  const draftNameError =
    draftType !== "screenshot"
      ? null
      : draftNameTrim === ""
        ? "Enter a checkpoint name."
        : allNames.has(draftNameTrim)
          ? "That checkpoint name is already used."
          : null;
  const draftValid =
    draftType === "screenshot"
      ? draftNameError === null
      : draftType === "navigate"
        ? draftUrlTrim !== ""
        : draftSelectorTrim !== ""; // click / type — selector required (value may be empty)

  function addInsert() {
    if (!draft || !draftValid) return;
    let step: NewStepInput;
    if (draftType === "navigate") step = { type: "navigate", url: draftUrlTrim };
    else if (draftType === "screenshot") step = { type: "screenshot", name: draftNameTrim };
    else if (draftType === "click") step = { type: "click", selector: draftSelectorTrim };
    else step = { type: "type", selector: draftSelectorTrim, value: draftValue };
    insertId.current += 1;
    setInserts((prev) => [
      ...prev,
      { tempId: `i${insertId.current}`, atIndex: draft.atIndex, position: draft.position, step },
    ]);
    setDraft(null);
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
      const masksChanged =
        s.type === "screenshot" &&
        JSON.stringify(masksByIndex[s.index] ?? []) !== JSON.stringify(initialMasksByIndex[s.index] ?? []);
      const compareModeChanged =
        s.type === "screenshot" &&
        (compareModes[s.index] ?? "pixel") !== (initialCompareModes[s.index] ?? "pixel");
      const promptChanged =
        s.type === "screenshot" && (prompts[s.index] ?? "") !== (initialPrompts[s.index] ?? "");

      // Typed value (type steps only): send when the literal actually changed.
      const valueChanged =
        s.type === "type" && (typedValues[s.index] ?? "") !== (initialValues[s.index] ?? "");

      // Locator: send only the signals that actually changed ("" = clear that signal).
      let targetPatch: FingerprintPatch | undefined;
      const td = targets[s.index];
      const ti = initialTargets[s.index];
      if (td && ti) {
        const fp: FingerprintPatch = {};
        for (const k of LOCATOR_FIELDS) {
          if ((td[k] ?? "") !== (ti[k] ?? "")) fp[k] = td[k];
        }
        if (Object.keys(fp).length > 0) targetPatch = fp;
      }

      if (
        !waitsChanged &&
        !thresholdChanged &&
        !masksChanged &&
        !valueChanged &&
        !targetPatch &&
        !compareModeChanged &&
        !promptChanged
      )
        return;
      const p: TestConfigStepPatch = { index: s.index };
      if (waitsChanged) p.waitBefore = stepWaits[i];
      if (thresholdChanged) p.threshold = Number(cur);
      if (masksChanged) p.masks = masksByIndex[s.index] ?? [];
      if (valueChanged) p.value = typedValues[s.index] ?? "";
      if (targetPatch) p.target = targetPatch;
      if (compareModeChanged) p.compareMode = compareModes[s.index];
      // Always send the prompt when the mode is context (so switching pixel→context carries the
      // required prompt to the server), plus whenever it changed.
      if (promptChanged || (compareModeChanged && compareModes[s.index] === "context")) {
        p.prompt = prompts[s.index] ?? "";
      }
      steps.push(p);
    });

    if (!defaultsChanged && steps.length === 0 && inserts.length === 0) return null;
    const patch: TestConfigPatch = { baseVersion: config.version };
    if (defaultsChanged) patch.defaults = defaultWaits;
    if (steps.length > 0) patch.steps = steps;
    if (inserts.length > 0) {
      patch.inserts = inserts.map(
        ({ atIndex, position, step }): TestConfigStepInsert => ({ atIndex, position, step }),
      );
    }
    return patch;
  }

  const patch = buildPatch();
  // A removed step's threshold can't block the save.
  const anyInvalid = config.steps.some(
    (s) => !removed.has(s.index) && (thresholdInvalid(s) || contextPromptInvalid(s)),
  );
  const canSave = patch !== null && !anyInvalid && !save.isPending;

  function onSave() {
    if (!patch) return;
    save.mutate(patch, {
      onSuccess: (res) => toast(`Saved — “${config.name}” is now v${res.version}`),
      onError: (e) => toast(e instanceof Error ? e.message : "Save failed"),
    });
  }

  // --- manual "add step" render helpers (staged inserts; see openInsert/addInsert above) ---
  const insertsAbove = (index: number) =>
    inserts.filter((x) => x.atIndex === index && x.position === "above");
  const insertsBelow = (index: number) =>
    inserts.filter((x) => x.atIndex === index && x.position === "below");

  const renderPending = (list: StagedInsert[]) =>
    list.map((ins) => {
      const Icon = NEW_STEP_ICON[ins.step.type];
      return (
        <div key={ins.tempId} className={styles.pendingStep}>
          <span className={styles.stepIcon}>
            <Icon size={14} />
          </span>
          <span className={styles.pendingLabel}>{newStepLabel(ins.step)}</span>
          <Badge tone="success" size="sm">
            Added
          </Badge>
          <span className={styles.stepHeadSpacer} />
          <IconButton
            variant="ghost"
            size="sm"
            icon={<Trash size={14} />}
            label="Remove added step"
            onClick={() => removeInsert(ins.tempId)}
          />
        </div>
      );
    });

  const stepTypeOptions: SegmentedOption<NewStepInput["type"]>[] = [
    { value: "screenshot", label: "Checkpoint", icon: <Eye size={14} /> },
    { value: "navigate", label: "Navigate", icon: <ExternalLink size={14} /> },
    { value: "click", label: "Click", icon: <MousePointer size={14} /> },
    { value: "type", label: "Type", icon: <Pencil size={14} /> },
  ];

  const renderZone = (atIndex: number, position: "above" | "below") => {
    const open = draft?.atIndex === atIndex && draft.position === position;
    if (!open) {
      return (
        <div className={styles.insertZone}>
          <button
            type="button"
            className={styles.insertPlus}
            onClick={() => openInsert(atIndex, position)}
            aria-label="Add a step here"
          >
            <Plus size={14} />
            <span className={styles.insertPlusText}>Add step</span>
          </button>
        </div>
      );
    }
    const onFieldKey = (e: ReactKeyboardEvent) => {
      if (e.key === "Enter" && draftValid) addInsert();
      if (e.key === "Escape") cancelInsert();
    };
    return (
      <div className={styles.insertForm}>
        <SegmentedControl
          ariaLabel="New step type"
          size="sm"
          options={stepTypeOptions}
          value={draftType}
          onValueChange={setDraftType}
        />
        {draftType === "screenshot" && (
          <Input
            // biome-ignore lint/a11y/noAutofocus: opening the inline form should focus its field.
            autoFocus
            inputSize="sm"
            value={draftName}
            invalid={draftNameError !== null && draftName.trim() !== ""}
            placeholder="Checkpoint name (e.g. Dashboard)"
            aria-label="Checkpoint name"
            className={styles.insertField}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={onFieldKey}
          />
        )}
        {draftType === "navigate" && (
          <Input
            // biome-ignore lint/a11y/noAutofocus: opening the inline form should focus its field.
            autoFocus
            inputSize="sm"
            mono
            value={draftUrl}
            placeholder="https://…  or  {{baseUrl}}/path"
            aria-label="Navigation URL"
            className={styles.insertField}
            onChange={(e) => setDraftUrl(e.target.value)}
            onKeyDown={onFieldKey}
          />
        )}
        {(draftType === "click" || draftType === "type") && (
          <Input
            // biome-ignore lint/a11y/noAutofocus: opening the inline form should focus its field.
            autoFocus
            inputSize="sm"
            mono
            value={draftSelector}
            placeholder="CSS or Playwright selector — e.g. #submit  or  text=Save"
            aria-label="Element selector"
            className={styles.insertField}
            onChange={(e) => setDraftSelector(e.target.value)}
            onKeyDown={onFieldKey}
          />
        )}
        {draftType === "type" && (
          <Input
            inputSize="sm"
            value={draftValue}
            placeholder="Text to type (supports {{token}})"
            aria-label="Text to type"
            className={styles.insertField}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={onFieldKey}
          />
        )}
        <Button variant="primary" size="sm" disabled={!draftValid} onClick={addInsert}>
          Add
        </Button>
        <Button variant="ghost" size="sm" onClick={cancelInsert}>
          Cancel
        </Button>
        {draftNameError && draftName.trim() !== "" && (
          <span className={styles.insertError}>{draftNameError}</span>
        )}
      </div>
    );
  };

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

          <NotesCard
            notes={config.notes}
            saving={notesUpdate.isPending}
            placeholder="Add a note about this test — coverage, known flakiness, ownership…"
            onSave={(text) =>
              notesUpdate.mutateAsync({ id: config.id, body: { notes: text } }).then(
                () => toast("Note saved"),
                (e) => {
                  toast(e instanceof Error ? e.message : "Couldn’t save note");
                  throw e;
                },
              )
            }
          />

          <RecentRunsCard testId={config.id} />

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
        <div className={styles.verifyBar}>
          {config.needsEnvironment && (
            <>
              <span className={styles.verifyBarLabel}>Verify against</span>
              <Select
                ariaLabel="Verify environment"
                selectSize="sm"
                value={verifyEnvId}
                onValueChange={setVerifyEnvId}
                placeholder="Select an environment"
                options={envList.map((e) => ({ value: e.id, label: e.name }))}
              />
            </>
          )}
          <span className={styles.verifyNote}>
            Verify drives the steps up to each one in a real browser, then checks the locator there.
          </span>
        </div>
        <div className={styles.steps}>
          {config.steps.map((s, i) => {
            const Icon = STEP_ICON[s.type];
            const locked = splitWaits(s.waitBefore).locked;
            const isLast = i === config.steps.length - 1;
            const isRemoved = removed.has(s.index);
            const canRemove = s.index !== 0; // the entry navigation is structural
            const maskCount = s.type === "screenshot" ? (masksByIndex[s.index]?.length ?? 0) : 0;
            return (
              <div key={s.index} className={styles.stepWrap}>
                {renderPending(insertsAbove(s.index))}
                {s.index !== 0 && renderZone(s.index, "above")}
                <div
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

                      {s.type === "type" && (
                        <div className={styles.valueRow}>
                          <Pencil size={13} />
                          <span className={styles.valueLabel}>Value</span>
                          <Input
                            inputSize="sm"
                            value={typedValues[s.index] ?? ""}
                            placeholder="(empty)"
                            aria-label={`Typed value for step ${i + 1}`}
                            className={styles.valueInput}
                            onChange={(e) => setTypedValue(s.index, e.target.value)}
                          />
                        </div>
                      )}

                      {s.target && (
                        <div className={styles.locator}>
                          <div className={styles.locatorHead}>
                            <MousePointer size={13} />
                            <span className={styles.locatorLabel}>Locator</span>
                            <span className={styles.locatorTag}>{s.target.tag}</span>
                          </div>
                          <div className={styles.locatorGrid}>
                            {(
                              [
                                ["role", "Role"],
                                ["accessibleName", "Name"],
                                ["text", "Text"],
                                ["testId", "Test id"],
                              ] as const
                            ).map(([field, label]) => (
                              <LocatorField
                                key={field}
                                label={label}
                                value={targets[s.index]?.[field] ?? ""}
                                onChange={(v) => setTargetField(s.index, field, v)}
                              />
                            ))}
                          </div>
                          <details className={styles.advanced}>
                            <summary className={styles.advancedSummary}>Advanced — raw selector override</summary>
                            <Input
                              inputSize="sm"
                              mono
                              value={targets[s.index]?.selectorOverride ?? ""}
                              placeholder="e.g. #submit-btn  or  .form > button"
                              aria-label="Selector override"
                              onChange={(e) => setTargetField(s.index, "selectorOverride", e.target.value)}
                            />
                            <div className={styles.advancedHelp}>
                              Used as-is when it resolves to exactly one element; otherwise the signals above are used.
                            </div>
                          </details>
                          <div className={styles.locatorHelp}>
                            Edit a signal, or clear one to drop it — the rest of the locator is kept. Applies on the next run.
                          </div>
                          <div className={styles.verifyRow}>
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={verifyingStep === s.index}
                              disabled={!canVerify}
                              onClick={() => onVerify(s.index)}
                            >
                              Verify
                            </Button>
                            {verdicts[s.index] && <Verdict result={verdicts[s.index]} />}
                          </div>
                        </div>
                      )}

                      {s.type === "screenshot" && (
                        <div className={styles.compareRow}>
                          <Eye size={13} />
                          <span className={styles.thresholdLabel}>Comparison</span>
                          <SegmentedControl<CompareMode>
                            options={[
                              { value: "pixel", label: "Pixel" },
                              { value: "context", label: "AI context" },
                            ]}
                            value={compareModes[s.index] ?? "pixel"}
                            onValueChange={(v) =>
                              setCompareModes((prev) => ({ ...prev, [s.index]: v }))
                            }
                          />
                          <span className={styles.thresholdHelp}>
                            {(compareModes[s.index] ?? "pixel") === "context"
                              ? "an LLM judges the current capture against the baseline"
                              : "exact pixel diff against the baseline"}
                          </span>
                        </div>
                      )}

                      {s.type === "screenshot" && compareModes[s.index] === "context" && (
                        <div
                          className={`${styles.promptRow} ${contextPromptInvalid(s) ? styles.thresholdRowError : ""}`}
                        >
                          <span className={styles.thresholdLabel}>Judge prompt (optional)</span>
                          <textarea
                            className={styles.promptInput}
                            rows={3}
                            placeholder="Leave blank to use the default judge prompt from Configurations — or override it here for this checkpoint."
                            aria-label={`Judge prompt for ${s.checkpointName ?? "checkpoint"}`}
                            value={prompts[s.index] ?? ""}
                            onChange={(e) =>
                              setPrompts((prev) => ({ ...prev, [s.index]: e.target.value }))
                            }
                          />
                          <span className={styles.thresholdHelp}>
                            Blank = inherit the global default from Configurations.
                          </span>
                        </div>
                      )}

                      {s.type === "screenshot" && compareModes[s.index] !== "context" && (
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

                      {s.type === "screenshot" && compareModes[s.index] !== "context" && (
                        <div className={styles.baselineBlock}>
                          <div className={styles.baselineHead}>
                            <Camera size={13} />
                            <span className={styles.baselineTitle}>Baseline &amp; masks</span>
                            {maskCount > 0 && (
                              <span className={styles.baselineCount}>
                                {maskCount} mask{maskCount === 1 ? "" : "s"}
                              </span>
                            )}
                          </div>
                          {s.baselineUrl ? (
                            <>
                              <p className={styles.baselineHelp}>
                                The current golden image for this checkpoint. Drag on it to mask a
                                volatile region; drag a mask to move it, or its handles to resize.
                                Masked areas are ignored when comparing, and changes apply on the
                                next run.
                              </p>
                              <BaselineMaskCanvas
                                src={s.baselineUrl}
                                masks={masksByIndex[s.index] ?? []}
                                onChange={(next) => setStepMasks(s.index, next)}
                              />
                            </>
                          ) : (
                            <div className={styles.maskEmpty}>
                              <span className={styles.maskEmptyIcon}>
                                <ImageOff size={20} />
                              </span>
                              <div className={styles.maskEmptyText}>
                                <strong>No baseline yet.</strong> Run this test and approve a baseline
                                for “{s.checkpointName}” — it’ll appear here, and you can draw mask
                                regions directly on it.
                              </div>
                              {maskCount > 0 && (
                                <Button variant="secondary" size="sm" onClick={() => setStepMasks(s.index, [])}>
                                  Clear {maskCount} mask{maskCount === 1 ? "" : "s"}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
                </div>
                {isLast && renderZone(s.index, "below")}
                {renderPending(insertsBelow(s.index))}
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
            ? inserts.length > 0
              ? `Saving writes a new version, adding ${inserts.length} step${inserts.length === 1 ? "" : "s"}${
                  removed.size > 0 ? ` and removing ${removed.size}` : ""
                } — it applies on the next run.`
              : removed.size > 0
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
 * A test's recent run history — the per-test slice of the Runs page. Each row shows the
 * derived outcome (so a Baseline-creation run reads differently from a Verified pass),
 * the environment, and when, and opens the run in the viewer. Polled like the Runs list.
 */
function RecentRunsCard({ testId }: { testId: string }) {
  const { navigate } = useRouter();
  const runs = useTestRuns(testId);
  const data = (runs.data ?? []).slice(0, 6);

  return (
    <Card>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon}>
          <Activity size={15} />
        </span>
        <div className={styles.cardHeadText}>
          <div className={styles.cardTitle}>Recent runs</div>
          <div className={styles.cardSub}>
            Baseline-creation runs vs verification passes for this test, newest first.
          </div>
        </div>
      </div>
      {runs.isLoading ? (
        <div className={styles.recentRuns}>
          <Skeleton height={30} radius="var(--radius-md)" />
          <Skeleton height={30} radius="var(--radius-md)" />
          <Skeleton height={30} radius="var(--radius-md)" />
        </div>
      ) : data.length === 0 ? (
        <div className={styles.recentEmpty}>No runs yet — trigger this test to see its history.</div>
      ) : (
        <ul className={styles.recentRuns}>
          {data.map((r) => (
            <li key={r.runId}>
              <button
                type="button"
                className={styles.recentRow}
                onClick={() => navigate({ name: "runDetail", runId: r.runId })}
              >
                <StatusBadge status={r.outcome} size="sm" />
                <span className={styles.recentEnv} title={r.environment}>
                  {r.environment}
                </span>
                <span className={styles.recentWhen}>{relativeTime(r.runTimestamp)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
  const update = useUpdateTest();
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);

  function onSave() {
    if (!draft || draft.error) return;
    update.mutate(
      { id: testId, body: { schedule: draftToInput(draft) } },
      {
        onSuccess: () => toast(draft.enabled ? "Schedule saved" : "Schedule saved — paused"),
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
      <ScheduleEditor
        initialSchedule={schedule}
        title="Schedule"
        subtitle="Run this test automatically on a cron. Off by default; a scheduled run lands in Runs and Needs Review exactly like a manual one."
        onChange={setDraft}
      />
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
          disabled={!draft || !!draft.error || update.isPending}
          loading={update.isPending}
          onClick={onSave}
        >
          Save schedule
        </Button>
      </div>
    </Card>
  );
}

/** One labelled locator-signal input (role / name / text / test id). Empty = the signal
 *  is absent or being cleared. */
function LocatorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className={styles.locatorField}>
      <span className={styles.locatorFieldLabel}>{label}</span>
      <Input
        inputSize="sm"
        value={value}
        placeholder="—"
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Inline verdict for a live locator verify (Slice 16.3b): resolved (with matched signal +
 *  healed flag), ambiguous, not-found, or — when the drive couldn't reach the step — the
 *  step that failed. */
function Verdict({ result }: { result: LocatorVerifyResult }) {
  if (result.failedStepIndex != null) {
    return (
      <span className={`${styles.verdict} ${styles.verdictWarn}`}>
        <AlertTriangle size={13} /> couldn’t reach this step — failed at step{" "}
        {result.failedStepIndex + 1}
        {result.failedStepLabel ? ` (${result.failedStepLabel})` : ""}
      </span>
    );
  }
  if (result.status === "resolved") {
    return (
      <span className={`${styles.verdict} ${styles.verdictOk}`}>
        <Check size={13} /> resolves{result.matchedSignal ? ` · ${result.matchedSignal}` : ""}
        {result.healed ? " · healed (weak signal)" : ""}
      </span>
    );
  }
  if (result.status === "ambiguous") {
    return (
      <span className={`${styles.verdict} ${styles.verdictWarn}`}>
        <AlertTriangle size={13} /> ambiguous — matches more than one element
      </span>
    );
  }
  return (
    <span className={`${styles.verdict} ${styles.verdictBad}`}>
      <AlertTriangle size={13} /> not found
    </span>
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

      {waits.map((w, i) => {
        const label =
          w.kind === "networkIdle" ? "Network idle" : w.kind === "streamIdle" ? "Stream idle" : "Delay";
        // Editable ms field: delay → ms; networkIdle → timeout; streamIdle → the max cap (timeout).
        const value =
          w.kind === "networkIdle"
            ? (w.timeoutMs ?? 10000)
            : w.kind === "streamIdle"
              ? (w.timeoutMs ?? 30000)
              : w.ms;
        return (
          <div key={i} className={styles.waitRow}>
            <span className={styles.waitKind}>
              {w.kind === "delay" ? <Clock size={13} /> : <Activity size={13} />}
              {label}
            </span>
            <Input
              inputSize="sm"
              mono
              type="number"
              min={w.kind === "delay" ? 0 : 1}
              step={100}
              className={styles.waitInput}
              aria-label={`${label} (ms)`}
              value={String(value)}
              onChange={(e) => {
                const raw = Math.floor(Number(e.target.value));
                if (w.kind === "networkIdle") {
                  update(i, { kind: "networkIdle", timeoutMs: Number.isFinite(raw) ? Math.max(1, raw) : 1 });
                } else if (w.kind === "streamIdle") {
                  update(i, { kind: "streamIdle", timeoutMs: Number.isFinite(raw) ? Math.max(1, raw) : 1 });
                } else {
                  update(i, { kind: "delay", ms: Number.isFinite(raw) ? Math.max(0, raw) : 0 });
                }
              }}
            />
            <span className={styles.waitUnit}>{w.kind === "streamIdle" ? "ms max" : "ms"}</span>
            <button type="button" className={styles.waitRemove} aria-label="Remove wait" onClick={() => remove(i)}>
              ×
            </button>
          </div>
        );
      })}

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
          onClick={() => onChange([...waits, { kind: "streamIdle", timeoutMs: 30000 }])}
          title="Wait until streaming/late-rendering content stops changing (best for Wisdom)"
        >
          <Activity size={13} /> Stream idle
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
