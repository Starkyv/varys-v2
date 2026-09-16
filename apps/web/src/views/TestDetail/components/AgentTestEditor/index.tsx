import type { AgentCheckpoint, TestConfigView } from "@varys/review-contract";
import {
  AlertTriangle,
  Badge,
  Button,
  Camera,
  Card,
  ChevronDown,
  Clock,
  cx,
  EmptyState,
  Eye,
  IconButton,
  Input,
  Plus,
  Select,
  Sparkles,
  Spinner,
  Trash,
} from "@varys/ui";
import { useState } from "react";
import { fetchAgentCheckpointDeleteImpact } from "../../../../api";
import { useConfirm } from "../../../../context/confirm";
import { useToast } from "../../../../context/toast";
import {
  useAddAgentCheckpoint,
  useAgentCheckpoints,
  useAgentInstructions,
  useDeleteAgentCheckpoint,
  useEnvironments,
  useReorderAgentCheckpoints,
  useUpdateAgentCheckpoint,
  useUpdateTest,
} from "../../../../queries";
import styles from "./styles.module.scss";

/**
 * The authoring surface for an **Agent-Driven Test** — the kind with no steps.
 *
 * It replaces the step/config editor entirely rather than extending it, because there is no
 * overlap: this kind has no fingerprints to tune, no waits to insert and no thresholds to set.
 * What it has is prose a person writes and an ordered list of Checkpoints.
 *
 * Nothing here writes a test version. That is the point of the kind, and the copy says so, because
 * an author used to every edit being audited will otherwise assume it silently was.
 */
export function AgentTestEditor({ config }: { config: TestConfigView }) {
  const checkpoints = useAgentCheckpoints(config.id);
  return (
    <>
      <InstructionsCard config={config} />
      <LeaseCard config={config} />
      <Card className={styles.card}>
        <header className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>Checkpoints</h2>
            <p className={styles.cardHint}>
              Walked in order, each one carrying on from the last — write only what changes. Every
              checkpoint must be reached for a run to pass; one that is never reached fails it.
            </p>
          </div>
          <Badge tone="neutral" size="sm">
            {checkpoints.data?.length ?? 0}
          </Badge>
        </header>

        {checkpoints.data?.length === 0 && (
          <EmptyState
            icon={<Camera size={20} />}
            tone="neutral"
            title="No checkpoints yet"
            description="Add the states this journey has to reach. Each one is captured and compared against its approved baseline."
          />
        )}

        <ol className={styles.list}>
          {(checkpoints.data ?? []).map((cp, i) => (
            <CheckpointRow
              key={cp.id}
              testId={config.id}
              checkpoint={cp}
              index={i}
              total={checkpoints.data?.length ?? 0}
              order={(checkpoints.data ?? []).map((c) => c.id)}
            />
          ))}
        </ol>

        <AddCheckpoint testId={config.id} />
      </Card>
      <ComposedInstructionsCard config={config} />
    </>
  );
}

/**
 * The three layers of AI Instructions — the suite's, this test's, and each checkpoint's — laid out
 * exactly as the next Agent Run Session will receive them.
 *
 * It exists because three layers assembled out of sight are what produce a baffling run an hour
 * later: the author who wrote one of them cannot otherwise tell what the other two turned it into.
 * Last on the page on purpose — everything above it is an input to what it shows.
 *
 * The text is fetched from the server rather than assembled here. A preview stitched together in
 * the browser would be a preview of a different document the moment either side drifted, and the
 * one thing this must be is the same document.
 */
function ComposedInstructionsCard({ config }: { config: TestConfigView }) {
  const [open, setOpen] = useState(false);
  const [environmentId, setEnvironmentId] = useState("");
  const environments = useEnvironments({ enabled: open });
  const preview = useAgentInstructions(config.id, environmentId || null, { enabled: open });

  return (
    <Card className={styles.card}>
      <button
        type="button"
        className={styles.previewToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown size={14} className={cx(styles.chevron, open && styles.chevronOpen)} />
        <Eye size={15} />
        <span className={styles.cardTitle}>Composed instructions</span>
        <span className={styles.previewHint}>
          what the agent is handed — suite, then this test, then each checkpoint
        </span>
      </button>

      {open && (
        <div className={styles.preview}>
          <div className={styles.previewBar}>
            <span className={styles.label}>Environment</span>
            <Select
              selectSize="sm"
              className={styles.previewEnv}
              ariaLabel="Environment to compose against"
              value={environmentId}
              onValueChange={setEnvironmentId}
              options={[
                { value: "", label: "None (default)" },
                ...(environments.data ?? []).map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
            {preview.isFetching && <Spinner size={14} />}
            {preview.data && (
              <span className={styles.previewMeta}>
                {preview.data.suites.length > 0
                  ? `Includes shared context from ${preview.data.suites.join(", ")}`
                  : "No suite contributes to this test"}
              </span>
            )}
          </div>

          {preview.isError && (
            <p className={styles.previewError}>
              {preview.error instanceof Error
                ? preview.error.message
                : "Couldn’t compose the instructions"}
            </p>
          )}
          {preview.data && <pre className={styles.previewBody}>{preview.data.instructions}</pre>}
        </div>
      )}
    </Card>
  );
}

/**
 * The test-level AI Instructions.
 *
 * Stored on `tests.intent` — the same field a pinned test's Brief uses — and written through the
 * structural test patch, so saving writes no new version.
 */
function InstructionsCard({ config }: { config: TestConfigView }) {
  const update = useUpdateTest();
  const { toast } = useToast();
  const [value, setValue] = useState(config.brief ?? "");
  const dirty = value !== (config.brief ?? "");

  return (
    <Card className={styles.card}>
      <header className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>
            <Sparkles size={15} /> AI instructions
          </h2>
          <p className={styles.cardHint}>
            What is true for the whole run: which app, which account, and anything to ignore or
            never touch. Each checkpoint adds its own instructions on top of this.
          </p>
        </div>
      </header>
      <textarea
        className={styles.textarea}
        rows={7}
        value={value}
        placeholder={
          "App is staging.acme.io. Log in as qa@acme.io / hunter2-staging.\nDismiss the cookie banner if it appears. Ignore the “What’s new” modal.\nNever click Delete."
        }
        onChange={(e) => setValue(e.target.value)}
      />
      <div className={styles.rowActions}>
        <span className={styles.note}>
          Credentials live here as plain text, and are sent to whichever Claude runs this test.
        </span>
        <Button
          size="sm"
          disabled={!dirty || update.isPending}
          onClick={() =>
            update.mutate(
              { id: config.id, body: { brief: value } },
              {
                onSuccess: () => toast("Instructions saved"),
                onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t save instructions"),
              },
            )
          }
        >
          Save instructions
        </Button>
      </div>
    </Card>
  );
}

/**
 * The wall-clock lease — how long a run of this test may take before Varys closes the session.
 *
 * The one setting on this page that is a RULE rather than intent. Everything else here is prose
 * handed to an agent that may or may not act on it; this is enforced server-side, because the
 * thing it bounds is an agent that has decided to keep trying and would not read a request to stop.
 *
 * Whole minutes, which is not the API's own granularity (it takes seconds) but is the only unit
 * anyone thinks about a run in. A lease set to something finer through the API is shown rounded.
 */
function LeaseCard({ config }: { config: TestConfigView }) {
  const update = useUpdateTest();
  const { toast } = useToast();
  const stored = Math.max(1, Math.round(config.agentLeaseSeconds / 60));
  const [minutes, setMinutes] = useState(String(stored));
  const parsed = Number(minutes);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 1440;
  const dirty = valid && parsed !== stored;

  return (
    <Card className={styles.card}>
      <header className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>
            <Clock size={15} /> Wall-clock lease
          </h2>
          <p className={styles.cardHint}>
            How long a run of this test may take before Varys closes the session. Retrying a state
            it could not reach is the agent’s own call — but an agent retrying one that will never
            appear has no reason to stop, and it is your Claude subscription it is spending.
          </p>
        </div>
      </header>
      <div className={styles.lease}>
        <label className={styles.field}>
          <span className={styles.label}>Minutes</span>
          <Input
            type="number"
            min={1}
            max={1440}
            step={1}
            inputSize="sm"
            invalid={!valid}
            className={styles.leaseInput}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
        <p className={styles.note}>
          When it runs out the session is closed and nothing more can be reported to it. The run is
          left <strong>red</strong>, not cancelled: an agent that drove for the whole lease and
          could not get there has found something out about the app or about these instructions.
        </p>
        <Button
          size="sm"
          disabled={!dirty || update.isPending}
          onClick={() =>
            update.mutate(
              { id: config.id, body: { agentLeaseSeconds: parsed * 60 } },
              {
                onSuccess: () => toast(`Runs now stop after ${parsed} minute${parsed === 1 ? "" : "s"}`),
                onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t save the lease"),
              },
            )
          }
        >
          Save lease
        </Button>
      </div>
    </Card>
  );
}

/** One Checkpoint: its name, how to reach it, and what counts as matching its baseline. */
function CheckpointRow({
  testId,
  checkpoint: cp,
  index,
  total,
  order,
}: {
  testId: string;
  checkpoint: AgentCheckpoint;
  index: number;
  total: number;
  order: string[];
}) {
  const save = useUpdateAgentCheckpoint(testId);
  const del = useDeleteAgentCheckpoint(testId);
  const reorder = useReorderAgentCheckpoints(testId);
  const confirm = useConfirm();
  const { toast } = useToast();

  const [name, setName] = useState(cp.name);
  const [instructions, setInstructions] = useState(cp.instructions);
  const [comparePrompt, setComparePrompt] = useState(cp.comparePrompt);
  const dirty =
    name !== cp.name || instructions !== cp.instructions || comparePrompt !== cp.comparePrompt;

  function move(delta: number) {
    const next = [...order];
    const to = index + delta;
    if (to < 0 || to >= total) return;
    [next[index], next[to]] = [next[to], next[index]];
    reorder.mutate(next, {
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t reorder"),
    });
  }

  async function remove() {
    // Ask what this costs BEFORE doing it: deleting a checkpoint drops its approved baselines in
    // every environment, and finding that out afterwards is how people stop trusting the editor.
    let detail = "This removes the checkpoint from the journey.";
    try {
      const impact = await fetchAgentCheckpointDeleteImpact(testId, cp.id);
      if (impact.baselineCount > 0) {
        detail = `This also drops ${impact.baselineCount} approved baseline${
          impact.baselineCount === 1 ? "" : "s"
        } (${impact.environments.join(", ")}). They cannot be recovered — the next run re-proposes them for approval.`;
      } else {
        detail = "No baselines have been approved for it yet, so nothing else is lost.";
      }
    } catch {
      // Never block the delete on the impact lookup, but do not claim a cost we failed to read.
      detail = "Couldn’t check which baselines this would drop. It may remove approved baselines.";
    }

    const ok = await confirm({
      title: `Delete “${cp.name}”?`,
      message: detail,
      confirmLabel: "Delete checkpoint",
      tone: "danger",
    });
    if (!ok) return;
    del.mutate(cp.id, {
      onSuccess: () => toast(`Deleted “${cp.name}”`),
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t delete checkpoint"),
    });
  }

  return (
    <li className={styles.row}>
      <div className={styles.rowRail}>
        <span className={styles.position}>{index + 1}</span>
        <IconButton
          label="Move earlier"
          size="sm"
          variant="ghost"
          disabled={index === 0 || reorder.isPending}
          onClick={() => move(-1)}
          icon={
            <span className={styles.flip}>
              <ChevronDown size={14} />
            </span>
          }
        />
        <IconButton
          label="Move later"
          size="sm"
          variant="ghost"
          disabled={index === total - 1 || reorder.isPending}
          onClick={() => move(1)}
          icon={<ChevronDown size={14} />}
        />
      </div>

      <div className={styles.rowBody}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <Input inputSize="sm" mono value={name} onChange={(e) => setName(e.target.value)} />
          <span className={styles.note}>
            Keys this checkpoint’s baseline. Renaming carries its approved baselines with it.
          </span>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>How to get here</span>
          <textarea
            className={styles.textarea}
            rows={2}
            value={instructions}
            placeholder="Set the date range to last 7 days"
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>What counts as matching</span>
          <textarea
            className={styles.textarea}
            rows={2}
            value={comparePrompt}
            placeholder="Chart redrawn, header reads a 7-day range, no error toast. The data values will differ — that is fine."
            onChange={(e) => setComparePrompt(e.target.value)}
          />
          <span className={styles.note}>
            Compared by Claude against the approved baseline, never pixel by pixel. Leave empty to
            use the default judge prompt from Configurations.
          </span>
        </label>

        <div className={styles.rowActions}>
          <Button
            size="sm"
            variant="danger"
            iconLeft={<Trash size={14} />}
            disabled={del.isPending}
            onClick={remove}
          >
            Delete
          </Button>
          <Button
            size="sm"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate(
                { checkpointId: cp.id, body: { name, instructions, comparePrompt } },
                {
                  onSuccess: () => toast(`Saved “${name}”`),
                  onError: (e) => {
                    toast(e instanceof Error ? e.message : "Couldn’t save checkpoint");
                    setName(cp.name);
                  },
                },
              )
            }
          >
            Save
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Append a Checkpoint. Name only — the prose is written in the row once it exists. */
function AddCheckpoint({ testId }: { testId: string }) {
  const add = useAddAgentCheckpoint(testId);
  const { toast } = useToast();
  const [name, setName] = useState("");

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    add.mutate(
      { name: trimmed },
      {
        onSuccess: () => {
          setName("");
          toast(`Added “${trimmed}”`);
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t add checkpoint"),
      },
    );
  }

  return (
    <div className={styles.add}>
      <Input
        inputSize="sm"
        mono
        value={name}
        placeholder="dashboard-loaded"
        aria-label="New checkpoint name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <Button size="sm" iconLeft={<Plus size={14} />} disabled={!name.trim() || add.isPending} onClick={submit}>
        Add checkpoint
      </Button>
    </div>
  );
}

/** The banner explaining why this test looks nothing like the others. */
export function AgentTestNotice() {
  return (
    <div className={styles.notice}>
      <AlertTriangle size={15} />
      <span>
        This is an <strong>agent-driven</strong> test: it has no recorded steps. Your own local
        Claude walks these instructions each run, so it can’t be added to a suite or a schedule —
        there is nothing to run it unattended. Editing anything here writes no new version.
      </span>
    </div>
  );
}
