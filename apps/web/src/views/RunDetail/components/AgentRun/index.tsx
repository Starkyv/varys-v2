import type { CheckpointView, RunEvidenceView, RunView, UnreachedRootCause } from "@varys/review-contract";
import { AlertTriangle, Badge, Camera, ChevronDown, cx, Sparkles } from "@varys/ui";
import { useState } from "react";
import { type GalleryImage, ZoomableImage } from "../../../../components/ZoomableImage";
import { absoluteTime } from "../../../../lib/format";
import { DecisionBar } from "../DecisionBar";
import { DiffStage } from "../DiffStage";
import { checkpointBadge } from "../RunTimeline";
import styles from "./styles.module.scss";

/**
 * The run view for an **Agent-Driven Test** — the place the whole design either pays off or
 * doesn't.
 *
 * A pinned run is shown as a timeline, because Varys drove it and knows every step. It knows none
 * of that here: it supplied no browser, watched no driving, and holds only what the session chose
 * to report. So this is not a timeline with the steps missing — it is a different object, and the
 * three things it has to say clearly are the three things a reader would otherwise get wrong:
 *
 *  - **The argument, beside the evidence.** Every filled slot puts the agent's reasoning next to
 *    the two images it is an argument about. Nobody is being asked to trust a verdict; they are
 *    being shown the case for it, which is the entire compensating control for letting the session
 *    that drove also be the session that judged.
 *  - **"Could not get there" ≠ "got there and it looked wrong."** Two different facts with two
 *    different owners — one is about the journey, one is about the application — and collapsing
 *    them into a single red is what makes people stop reading run views.
 *  - **One root cause, not five failures.** A Checkpoint Manifest is cumulative, so when login
 *    breaks the four screens behind it were never reachable. Presenting those as peers turns one
 *    fact into four mysteries.
 */
export function AgentRun({
  run,
  gallery,
}: {
  run: RunView;
  /** Run-wide ordered images so the lightbox can traverse the whole run with the arrow keys. */
  gallery: GalleryImage[];
}) {
  // Every unfilled slot other than the one that caused the stop. Held as a set so the list below
  // can subordinate them without re-deriving which is which — the cause is the server's call, and
  // two surfaces disagreeing about it is exactly what `deriveUnreachedRootCause` exists to stop.
  const consequences = new Set(run.unreached?.alsoUnreached ?? []);

  return (
    <div className={styles.body}>
      {run.unreached && (
        <RootCause
          cause={run.unreached}
          total={run.checkpoints.length}
          // A session that never called `finish_agent_run` has not necessarily stopped — it may
          // still be walking. Varys cannot tell the two apart (that is what a wall-clock lease is
          // for), so the summary's presence is the only honest signal it has about which one to
          // say, and the wording changes accordingly rather than guessing.
          finished={run.agentSummary != null}
        />
      )}
      {run.agentSummary && <SessionSummary summary={run.agentSummary} />}

      <section className={styles.slots} aria-label="Checkpoints">
        {run.checkpoints.map((cp, i) => (
          <AgentCheckpoint
            key={cp.name}
            checkpoint={cp}
            runId={run.runId}
            step={i + 1}
            total={run.checkpoints.length}
            gallery={gallery}
            consequenceOf={consequences.has(cp.name) ? (run.unreached?.checkpointName ?? null) : null}
          />
        ))}
      </section>

      <Evidence items={run.evidence} />
      {run.agentInstructions && <Instructions text={run.agentInstructions} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  One root cause                                                     *
 * ------------------------------------------------------------------ */

/**
 * The single finding behind every unfilled slot, stated once and at the top.
 *
 * Deliberately worded as *where the journey stopped* rather than *what is broken*: Varys did not
 * watch the driving and has no idea why the agent could not get there. Naming the slot and the one
 * before it is the most it can honestly say, and it is also the most useful — "it got as far as
 * login and no further" is where someone starts looking.
 */
function RootCause({
  cause,
  total,
  finished,
}: {
  cause: UnreachedRootCause;
  total: number;
  /** Whether the session closed itself with a summary. Absent means "still open OR abandoned" —
   *  two states Varys genuinely cannot distinguish, so the wording commits to neither. */
  finished: boolean;
}) {
  const blocked = cause.alsoUnreached.length;

  const headline = !finished
    ? `“${cause.checkpointName}” has not been reported`
    : cause.resumed
      ? `“${cause.checkpointName}” was never reported, and the session carried on past it`
      : cause.lastReached
        ? `The journey stopped at “${cause.checkpointName}”`
        : `The journey never got started — “${cause.checkpointName}” was never reached`;

  const body = !finished
    ? "This session never closed itself, so it is either still walking the Manifest or it stopped without saying so. Until it does, an unfilled slot is exactly that and nothing more."
    : cause.resumed
      ? `${cause.lastReached ? `The session reached “${cause.lastReached}”, skipped this one, ` : "The session skipped this one, "}and then went on to report later checkpoints.`
      : cause.lastReached
        ? `The session reached “${cause.lastReached}” and then never reported “${cause.checkpointName}”.`
        : "Nothing at all was reported for this run, so there is no earlier state to work back from.";

  return (
    <div className={styles.rootCause} role="note">
      <div className={styles.rootCauseHead}>
        <AlertTriangle size={16} />
        <span className={styles.rootCauseTitle}>{headline}</span>
        <span className={styles.rootCauseMeta}>
          step {cause.step} of {total}
        </span>
      </div>
      <p className={styles.rootCauseBody}>
        {body}{" "}
        {blocked > 0 &&
          `The ${blocked === 1 ? "checkpoint" : `${blocked} checkpoints`} directly after it went unreported too, and ${blocked === 1 ? "was" : "were"} unreachable as a result: each one carries on from the last, so ${blocked === 1 ? "it is a consequence" : "they are consequences"} of this rather than ${blocked === 1 ? "a separate failure" : "separate failures"}.`}
      </p>
      {cause.resumed && (
        /* The honesty flag. One root cause is a way of not repeating yourself, never a licence to
           hide the second thing that went wrong — and the session demonstrably recovered, so
           anything still unreported further down is its own finding and is shown as one below. */
        <p className={styles.rootCauseCaveat}>
          Because the session recovered, this is not the only thing that went wrong — any later
          checkpoint still missing is a separate failure, and is shown as one below.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  The agent's own account                                            *
 * ------------------------------------------------------------------ */

/**
 * The session summary — the only record of the part Varys could not observe.
 *
 * Toned as a narrative and nothing more: the run's outcome was computed from its rows before this
 * text existed and is completely unaffected by it, which is why an account that says "all good"
 * can sit above a red badge without either of them being wrong.
 */
function SessionSummary({ summary }: { summary: string }) {
  return (
    <div className={styles.summary}>
      <div className={styles.summaryHead}>
        <Sparkles size={15} />
        <span className={styles.summaryTitle}>What the agent reported</span>
      </div>
      <p className={styles.summaryBody}>{summary}</p>
      <p className={styles.summaryFoot}>
        The session's own account, in its own words. The run's outcome above was computed from what
        it actually filled in — nothing written here changes it.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  One Manifest slot                                                  *
 * ------------------------------------------------------------------ */

/**
 * The slot's state badge, derived by the SAME function the pinned timeline's rail uses.
 *
 * Shared rather than re-spelled because the badge has to agree with `DecisionBar` (which is also
 * shared) and with the run's own outcome — and a second vocabulary written here would be a second
 * place for "Rejected" or "Unreached" to quietly mean something else.
 */
function SlotBadge({ checkpoint }: { checkpoint: CheckpointView }) {
  const { label, tone, Icon } = checkpointBadge(checkpoint);
  return (
    <Badge tone={tone} size="sm" icon={<Icon size={12} />}>
      {label}
    </Badge>
  );
}

/** How the capture was produced, as the agent described it — three optional fields, shown only
 *  when at least one was volunteered. */
function CaptureLine({ capture }: { capture: NonNullable<CheckpointView["capture"]> }) {
  const parts = [
    capture.tool,
    capture.viewport,
    capture.deviceScale != null ? `${capture.deviceScale}× scale` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <span
      className={styles.capture}
      title="How the agent said it took this screenshot. Varys hosts no browser for this kind, so this is testimony it cannot verify — read it when a comparison looks strange."
    >
      <Camera size={13} />
      {parts.join(" · ")}
    </span>
  );
}

function AgentCheckpoint({
  checkpoint: cp,
  runId,
  step,
  total,
  gallery,
  consequenceOf,
}: {
  checkpoint: CheckpointView;
  runId: string;
  step: number;
  total: number;
  gallery: GalleryImage[];
  /** Set when this slot went unfilled because an EARLIER one did — it is fallout, not a finding,
   *  and is rendered subordinate so the reader counts one failure instead of four. */
  consequenceOf: string | null;
}) {
  const unreached = cp.reviewState === "missing";

  // A consequence of an earlier stop: one line, no stage, no affordances. There is nothing here
  // to look at, and giving it the same weight as a real finding is precisely the thing that makes
  // a reader stop counting.
  if (unreached && consequenceOf) {
    return (
      <div className={cx(styles.slot, styles.slotConsequence)}>
        <div className={styles.slotHead}>
          <span className={styles.step}>{step}</span>
          <span className={styles.slotName}>{cp.name}</span>
          <SlotBadge checkpoint={cp} />
        </div>
        <p className={styles.consequenceText}>
          Never reached, because the journey had already stopped at “{consequenceOf}”. Not a separate
          failure — nothing was looked at here.
        </p>
      </div>
    );
  }

  return (
    <div className={cx(styles.slot, unreached && styles.slotUnreached)}>
      <div className={styles.slotHead}>
        <span className={styles.step}>{step}</span>
        <span className={styles.slotName}>{cp.name}</span>
        <SlotBadge checkpoint={cp} />
        <span className={styles.slotSpacer} />
        <span className={styles.slotMeta}>
          step {step} of {total}
        </span>
        {cp.capture && <CaptureLine capture={cp.capture} />}
      </div>

      {unreached ? (
        /* Textually and visually its own thing: no images, no verdict, no argument — because none
           of those exist. The distinction this card is carrying is that "could not get there" is a
           fact about the JOURNEY, where a failed comparison is a fact about the APPLICATION, and
           the two go to different people. */
        <div className={styles.unreached}>
          <AlertTriangle size={20} />
          <div>
            <div className={styles.unreachedTitle}>Never reached — nothing was captured</div>
            <p className={styles.unreachedText}>
              This is not a failed comparison. A failed comparison is a fact about the
              application — someone got there, looked, and something was wrong. This is a fact
              about the journey: nobody got there, so there is no screenshot and no verdict. The
              run is red because the slot is empty.
            </p>
          </div>
        </div>
      ) : (
        /* Reasoning BESIDE both images, on the same row. The session that drove is the session that
           judged, holding both pictures — so the rationale is not a footnote to the verdict, it is
           the only thing that makes the verdict reviewable at all. Putting it anywhere else invites
           reading the badge and moving on. */
        <div className={styles.compare}>
          <div className={styles.stage}>
            <DiffStage checkpoint={cp} mode="side-by-side" swipe={50} onion={50} gallery={gallery} />
          </div>
          <aside className={styles.argument}>
            <div className={styles.argumentHead}>
              <Sparkles size={14} />
              <span>
                {cp.reviewState === "diff"
                  ? "Why the agent called this a fail"
                  : cp.reviewState === "pending-baseline"
                    ? "What the agent saw"
                    : "Why the agent called this a pass"}
              </span>
            </div>
            {cp.judgeReasoning ? (
              <p className={styles.argumentBody}>{cp.judgeReasoning}</p>
            ) : (
              <p className={styles.argumentEmpty}>
                No reasoning was recorded for this capture.
              </p>
            )}
            {cp.reviewState === "pending-baseline" && (
              <p className={styles.argumentFoot}>
                There was no approved baseline in this environment, so whatever the agent concluded,
                this capture is a proposal awaiting your approval — not a pass.
              </p>
            )}
          </aside>
        </div>
      )}

      <DecisionBar checkpoint={cp} runId={runId} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Evidence                                                           *
 * ------------------------------------------------------------------ */

/**
 * Extra screenshots the agent attached mid-session — unnamed, keying no baseline, filling no slot.
 *
 * Beside the checkpoints rather than filed somewhere else, because "here is what I was looking at
 * when I got stuck" is what tells a broken application from a wrong instruction, and the person
 * who needs it is already staring at the failure.
 */
function Evidence({ items }: { items: RunEvidenceView[] }) {
  if (items.length === 0) return null;
  const gallery = items.map((e, i) => ({ src: e.url, label: e.note || `Evidence ${i + 1}` }));
  return (
    <section className={styles.evidence} aria-label="Run evidence">
      <div className={styles.evidenceHead}>
        <Camera size={15} />
        <span className={styles.evidenceTitle}>Evidence the agent attached</span>
        <span className={styles.evidenceMeta}>
          {items.length} screenshot{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className={styles.evidenceLead}>
        Attached during the session and keyed to nothing — these fill no checkpoint and can never
        become a baseline. They are what the agent was looking at.
      </p>
      <div className={styles.evidenceGrid}>
        {items.map((e, i) => (
          <figure key={e.id} className={styles.evidenceItem}>
            <ZoomableImage
              src={e.url}
              alt={e.note || `Evidence ${i + 1}`}
              imgClassName={styles.evidenceImg}
              caption={e.note || `Evidence ${i + 1}`}
              gallery={gallery}
            />
            <figcaption className={styles.evidenceCaption}>
              {e.note || <span className={styles.evidenceUnnoted}>No note</span>}
              <span className={styles.evidenceTime}>{absoluteTime(e.createdAt)}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 *  What the agent was told                                            *
 * ------------------------------------------------------------------ */

/**
 * The composed AI Instructions, copied onto the run when the session started.
 *
 * Collapsed by default because it is long and is not what anyone opens a run to read — but present,
 * because instructions and checkpoints are unversioned by design: edit the wording and every past
 * run becomes unexplainable without this copy. It is also where the plaintext credentials live, by
 * explicit decision, so it is not put on screen unasked.
 */
function Instructions({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={styles.instructions}>
      <button
        type="button"
        className={styles.instructionsToggle}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={14} className={cx(styles.chevron, open && styles.chevronOpen)} />
        What the agent was told
        <span className={styles.instructionsHint}>
          the composed instructions, exactly as this run received them
        </span>
      </button>
      {open && <pre className={styles.instructionsBody}>{text}</pre>}
    </section>
  );
}
