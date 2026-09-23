import type { DraftSummary } from "@varys/review-contract";
import { AlertTriangle, Badge, Button, Check, Eye, IconButton, Pencil, Play, Select, Skeleton, Trash } from "@varys/ui";
import { useEffect, useState } from "react";
import { AgentCheckpointList } from "../../../../components/AgentCheckpointList";
import { ZoomableImage } from "../../../../components/ZoomableImage";
import { useToast } from "../../../../context/toast";
import { relativeTime } from "../../../../lib/format";
import { useDraft, useEnvironments, useRenameDraft, useSeedDraftBaselines } from "../../../../queries";
import styles from "./styles.module.scss";

/**
 * The review-queue inspector — the right pane of the master-detail. Shows the selected
 * draft in enough depth to judge it without leaving the queue: the Brief, a
 * zero-checkpoint warning, what it asserts (the authoring-preview screenshots Claude
 * captured, via GET /drafts/:id), and the review actions. Recreated from the Claude Design
 * review-queue mock.
 *
 * **It reads two kinds, and they are judged differently.** A pinned Draft is judged on its
 * pictures: the steering sentence that asked for it, then a screenshot per recorded checkpoint.
 * An **Agent-Driven** one is judged on its *prose* — the AI Instructions a future run is driven
 * by, and per Checkpoint how a run reaches the state and what counts as matching. The picture is
 * evidence the state was reachable, not the assertion itself, so it sits beside the words rather
 * than standing in for them. Panels that mean nothing for a kind are absent, not empty: an empty
 * panel reads as missing data and sends a reviewer looking for something that was never there.
 */
export function DraftInspector({
  draft,
  onPromote,
  onDiscard,
  onRunPreview,
  onOpenEditor,
}: {
  draft: DraftSummary;
  onPromote: () => void;
  onDiscard: () => void;
  onRunPreview: () => void;
  onOpenEditor: () => void;
}) {
  // Per-checkpoint authoring previews — fetched only for the selected draft.
  const detail = useDraft(draft.id);
  const checkpoints = detail.data?.checkpoints ?? [];
  const zero = draft.checkpointCount === 0;
  const agent = draft.kind === "agent";

  const { toast } = useToast();
  const rename = useRenameDraft();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  // Approving the authoring captures as baselines. Only an Agent-Driven Draft offers it: a
  // pinned checkpoint is pixel-diffed, so its golden has to come off the runner that will
  // replay it, and the server refuses this route for that kind.
  const environments = useEnvironments({ enabled: agent });
  const seed = useSeedDraftBaselines();
  const [envId, setEnvId] = useState("");

  // Clear the pick when a different draft is selected — an environment chosen for one draft is
  // not a choice anyone made about the next.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on selection change.
  useEffect(() => setEnvId(""), [draft.id]);

  function approveCaptures() {
    if (!envId) return;
    seed.mutate(
      { id: draft.id, body: { environmentId: envId } },
      {
        onSuccess: (r) => {
          // Report what was RECORDED, never what was asked for: a checkpoint with no capture, or
          // one already baselined, is skipped — and "approved" over the top of that would be a
          // reviewer believing they had decided something they had not.
          const done = r.seeded.length
            ? `Approved ${r.seeded.length} capture${r.seeded.length === 1 ? "" : "s"} as ${r.environment} baselines`
            : `Nothing approved for ${r.environment}`;
          toast(r.skipped.length ? `${done} — ${r.skipped.length} skipped` : done);
        },
        onError: (e) => toast(e instanceof Error ? e.message : "Could not approve the captures"),
      },
    );
  }

  // Drop out of edit mode when a different draft is selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on selection change.
  useEffect(() => setEditing(false), [draft.id]);

  function startRename() {
    setValue(draft.name);
    setEditing(true);
  }

  function commitRename() {
    const name = value.trim();
    setEditing(false);
    if (!name || name === draft.name) return;
    rename.mutate(
      { id: draft.id, name },
      {
        onSuccess: () => toast(`Renamed to “${name}”`),
        onError: (e) => toast(e instanceof Error ? e.message : "Rename failed"),
      },
    );
  }

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        {editing ? (
          // biome-ignore lint/a11y/noAutofocus: entering rename should focus the field immediately.
          <input
            autoFocus
            className={styles.nameInput}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label="Test name"
          />
        ) : (
          <h2 className={styles.name}>
            {draft.name}
            <IconButton
              variant="ghost"
              size="sm"
              icon={<Pencil size={14} />}
              label="Rename test"
              className={styles.renameBtn}
              onClick={startRename}
            />
          </h2>
        )}
        <div className={styles.tags}>
          {agent && (
            <Badge tone="neutral" appearance="soft" size="sm">
              Agent-driven
            </Badge>
          )}
          <Badge tone="primary" appearance="soft" size="sm">
            AI-authored
          </Badge>
        </div>
      </header>

      <div className={styles.body}>
        {/* The Brief. Same column, two different things: a pinned Draft records the sentence
            that ASKED for the test; an Agent-Driven one holds the instructions Claude WROTE,
            which every future run is composed from — so for that kind this panel is the artifact
            under review, not context for it. */}
        {agent ? (
          detail.data?.intent ? (
            <div className={styles.intent}>
              <span className={styles.intentLabel}>AI Instructions</span>
              <pre className={styles.instructions}>{detail.data.intent}</pre>
            </div>
          ) : (
            <div className={styles.noIntent}>
              No AI Instructions were written. Every run of this test is driven by them, so it has
              nothing to go on — add them in the editor before promoting.
            </div>
          )
        ) : draft.intent ? (
          <div className={styles.intent}>
            <span className={styles.intentLabel}>Steering intent</span>
            <p className={styles.intentText}>{draft.intent}</p>
          </div>
        ) : (
          <div className={styles.noIntent}>
            No steering instruction was recorded. Lean on the checkpoints and steps below to judge
            what this test is meant to verify.
          </div>
        )}

        {zero && (
          <div className={styles.zeroWarn}>
            <AlertTriangle size={18} />
            <div>
              <div className={styles.zeroTitle}>
                {agent ? "This test cannot be run" : "This test asserts nothing"}
              </div>
              <p className={styles.zeroText}>
                {agent
                  ? // Not the pinned wording: an Agent-Driven Test with no Checkpoints is refused
                    // outright at run start, so "it will run but never catch a regression" would be
                    // false — and would send a reviewer off to run it and find out.
                    "Zero Checkpoints — starting a run on it is refused, because there is nothing for the run to reach or compare. Add at least one in the editor; promoting it as it stands produces a test nobody can run."
                  : "Zero visual checkpoints — it will run but never catch a regression. You can still promote it, but add a checkpoint in the editor first."}
              </p>
            </div>
          </div>
        )}

        <div className={styles.metaGrid}>
          <div className={styles.metaCell}>
            <div className={styles.metaLabel}>Checkpoints</div>
            <div className={styles.metaValue}>
              {draft.checkpointCount} checkpoint{draft.checkpointCount === 1 ? "" : "s"}
            </div>
          </div>
          <div className={styles.metaCell}>
            <div className={styles.metaLabel}>Authored</div>
            <div className={styles.metaValue}>{relativeTime(draft.createdAt)}</div>
          </div>
        </div>

        {!zero && (
          <section className={styles.previews}>
            <div className={styles.sectionLabel}>{agent ? "The journey" : "What it asserts"}</div>
            {detail.isLoading ? (
              <div className={styles.previewGrid}>
                <Skeleton height={132} radius="var(--radius-lg)" />
                <Skeleton height={132} radius="var(--radius-lg)" />
              </div>
            ) : checkpoints.length === 0 ? (
              <div className={styles.previewEmpty}>No checkpoint previews were captured.</div>
            ) : agent ? (
              // The same component the Author page shows while Claude writes these, so a reviewer
              // who watched the journey being authored reads the identical layout here.
              <AgentCheckpointList checkpoints={checkpoints} />
            ) : (
              <div className={styles.previewGrid}>
                {checkpoints.map((cp) => (
                  <figure key={cp.name} className={styles.preview}>
                    <div className={styles.previewImage}>
                      {cp.previewUrl ? (
                        <ZoomableImage
                          src={cp.previewUrl}
                          alt={`Preview of “${cp.name}”`}
                          caption={cp.name}
                          className={styles.previewZoom}
                        />
                      ) : (
                        <span className={styles.previewMissing}>
                          <Eye size={18} />
                          no preview
                        </span>
                      )}
                      {cp.captureMode && <span className={styles.previewMode}>{cp.captureMode}</span>}
                    </div>
                    <figcaption className={styles.previewName}>{cp.name}</figcaption>
                  </figure>
                ))}
              </div>
            )}
            {agent && (
              <div className={styles.baselineBox}>
                <p className={styles.cpNote}>
                  The captures are what Claude saw when it reached each state. They are evidence
                  until you say otherwise — approve them below and they become the baselines this
                  test is judged against, for the environment you pick. Approving is the whole
                  decision: nothing else here declares what “correct” looks like.
                </p>
                <div className={styles.baselineRow}>
                  <Select
                    className={styles.baselineSelect}
                    ariaLabel="Environment these captures are correct for"
                    options={(environments.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
                    value={envId}
                    onValueChange={setEnvId}
                    placeholder={environments.isLoading ? "Loading…" : "Pick an environment"}
                    selectSize="sm"
                    disabled={seed.isPending || (environments.data ?? []).length === 0}
                  />
                  <Button
                    variant="secondary"
                    iconLeft={<Check size={14} />}
                    disabled={!envId || seed.isPending || checkpoints.length === 0}
                    onClick={approveCaptures}
                  >
                    {seed.isPending ? "Approving…" : "Approve as baselines"}
                  </Button>
                </div>
                {detail.data?.baselinedEnvironments.length ? (
                  <p className={styles.baselineDone}>
                    Already has baselines for{" "}
                    {detail.data.baselinedEnvironments.join(", ")} — approving again leaves those
                    alone. Replacing a baseline is done from the run that disagreed with it.
                  </p>
                ) : null}
              </div>
            )}
          </section>
        )}
      </div>

      <footer className={styles.footer}>
        <Button variant="ghost" iconLeft={<Trash size={15} />} className={styles.discard} onClick={onDiscard}>
          Discard
        </Button>
        <span className={styles.footSpacer} />
        <Button variant="secondary" iconLeft={<Pencil size={15} />} onClick={onOpenEditor}>
          Open editor
        </Button>
        <Button variant="secondary" iconLeft={<Play size={14} />} onClick={onRunPreview}>
          Run preview
        </Button>
        <Button variant="primary" iconLeft={<Check size={15} />} onClick={onPromote}>
          Promote
        </Button>
      </footer>
    </div>
  );
}
