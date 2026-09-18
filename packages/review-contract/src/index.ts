/**
 * The shared, typed per-checkpoint review read-model — the single contract the
 * NestJS API produces and the `apps/web` review SPA consumes, so the two can't
 * silently drift (PRD: "build the read-model contract first").
 *
 * Pure types, zero runtime dependencies: the SPA imports this without dragging in
 * drizzle/pg or any Node-only code. The verdict (reviewState, diffScore) is computed
 * server-side and only *displayed* here — never recomputed on the client.
 */

/**
 * A checkpoint's review state.
 *
 * Three of the four are a capture's verdict: `pending-baseline` and `diff` need a human decision,
 * `passed` is the resolved one.
 *
 * `missing` is the odd one out and the only one no capture produces: it is a Checkpoint Manifest
 * slot that was EXPECTED and never filled (Agent-Driven Tests). Varys writes these rows before an
 * agent starts, so a slot that is never submitted stays `missing` and turns the run red — whether
 * the agent skipped it, crashed, or never reported at all. Nothing can be inferred from an absent
 * row, which is exactly why the state is written up front rather than reconciled afterwards.
 */
export type ReviewState = "pending-baseline" | "diff" | "passed" | "missing";

/* ------------------------------------------------------------------ *
 *  Agent-Driven Tests — the authoring surface                         *
 * ------------------------------------------------------------------ */

/**
 * One Checkpoint of an Agent-Driven Test: a slot in its Checkpoint Manifest.
 *
 * The rows are **cumulative** — `instructions` describe only the increment from the previous
 * checkpoint, because one Agent Run Session walks the list top to bottom carrying its own session
 * state. They are also **unversioned**: editing them writes no `test_version`.
 *
 * `id` is durable and `name` is a label, which is the distinction that lets a rename carry the
 * checkpoint's approved baselines rather than orphaning them.
 */
export interface AgentCheckpoint {
  id: string;
  /** Order within the journey — the sequence a Run walks, not a display hint. */
  position: number;
  /** Unique within the test. Keys a baseline per environment, and is the only name an agent may
   *  submit under once the Manifest is handed to it. */
  name: string;
  /** How to reach this state from the previous checkpoint. */
  instructions: string;
  /** What must be true in this screenshot for it to match its baseline. Empty falls back to the
   *  configured global default judge prompt. */
  comparePrompt: string;
}

/** Create an Agent-Driven Test. It is `active` on create with `origin: "human"` — a person types
 *  every word, so there is no machine-written artifact to promote. */
export interface CreateAgentTestRequest {
  name: string;
  /** The test-level AI Instructions (stored on `tests.intent`). Optional at create; the editor
   *  is where it is usually written. */
  instructions?: string;
}

/** Add or edit one Checkpoint. On edit every field is optional — omitted means unchanged. */
export interface AgentCheckpointInput {
  name?: string;
  instructions?: string;
  comparePrompt?: string;
}

/** Reorder the whole list in one write: the complete set of checkpoint ids, in the new order. */
export interface ReorderAgentCheckpointsRequest {
  ids: string[];
}

/**
 * What deleting a Checkpoint would cost, asked for BEFORE the delete.
 *
 * Deleting a slot drops its approved baselines in every environment, and the author should be
 * told which rather than discovering it afterwards — the same reason a rename is made to carry
 * them instead of silently orphaning them.
 */
export interface AgentCheckpointDeleteImpact {
  checkpointName: string;
  /** Environments holding an approved baseline for this checkpoint, which the delete would drop. */
  environments: string[];
  /** Total baseline rows that would go, across environments and viewports. */
  baselineCount: number;
}

/** How a checkpoint was captured (absent in old definitions ⇒ `element`). */
export type CaptureMode = "element" | "fullpage" | "region";
/** How a checkpoint's capture is compared to its baseline: classic pixel diff, or an LLM
 *  judge for non-deterministic content (Briefs, Wisdom). */
export type CompareMode = "pixel" | "context";

/** The audited decision a reviewer can take on a checkpoint. */
export type Resolution = "approved" | "rejected";

/** A rectangle in screenshot-pixel space (mask region; matches the step schema). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Candidate masks/threshold a reviewer is trying out (re-evaluate) or committing
 *  (persist). Both fields optional so the same shape serves masks (Issue 4) and
 *  threshold tuning (Issue 5). */
export interface TuningInput {
  masks?: Rect[];
  threshold?: number;
}

/** Result of a re-evaluate (preview) — the diff recomputed against the stored
 *  baseline+actual with candidate masks/threshold, with no new capture (no re-run). */
export interface ReEvaluation {
  verdict: "match" | "diff";
  /** Mismatched-pixel ratio in [0,1]. */
  diffScore: number;
  /** The threshold the verdict was judged against. */
  threshold: number;
  /** Transient diff image as a data URL (`data:image/png;base64,…`); not persisted. */
  diffImage: string | null;
}

/** Result of persisting masks/threshold: the named checkpoint's run_result was
 *  re-judged against the stored artifacts, and a new test_version was written. */
export interface PersistResult {
  /** The checkpoint's new review state (`passed` once within threshold). */
  reviewState: ReviewState;
  diffScore: number;
  threshold: number;
  /** The version number of the newly written test_version. */
  version: number;
}

/** Who authored a test: a human extension recording, or Claude via the MCP authoring
 *  layer (Slice 14). */
export type TestOrigin = "human" | "ai";

/**
 * Which kind of test this is.
 *
 * `pinned` — every test that existed before Agent-Driven Tests — is behaviour written down as
 * data: ordered steps, each carrying a Fingerprint, replayed by the worker with no model call.
 * `agent` is an **Agent-Driven Test**: no steps and no fingerprints, an ordered list of
 * Checkpoints that a locally-run Claude re-walks on every Run.
 *
 * The kind is a property of the TEST, not of its definition, because an Agent-Driven Test's
 * behaviour is unversioned — see {@link AgentCheckpoint}.
 */
export type TestKind = "pinned" | "agent";

/** A test's lifecycle: `draft` = an un-promoted AI authoring output (held out of suites
 *  and schedules, surfaced in the review queue); `active` = a normal, runnable test. */
export type TestStatus = "draft" | "active";

/**
 * A test's Repair Policy (Slice 19) — what happens when a run fails on a locator it cannot
 * resolve: `manual` (surface it; a human opens a Repair Session — today's behaviour) or `auto`
 * (enqueue a Repair Job for a cloud Claude to drain). Available to EVERY test regardless of how
 * it was authored; `manual` is the default, so nothing an author recorded starts changing
 * behind their back. Mirrors `RepairPolicy` in `@varys/repair-policy`, kept as a plain type
 * here so the SPA needs no dependency on that package.
 */
export type RepairPolicy = "manual" | "auto";

/**
 * The class of failure that ended a red run, when it is classified.
 *
 * `locator` — an unresolvable fingerprint — is the ONLY repairable class. Everything else enqueues
 * a read-only **Triage Job** instead (Slice 19, slice 08): Claude drives to the failure, looks, and
 * writes a finding onto the run, and the run stays red. Recording the class rather than inferring it
 * from the error text is what makes "may a repair touch this?" a fact instead of a regex.
 *
 *  - `pixel`     — a baseline existed and the capture differs. A visual change is not drift.
 *  - `judge`     — a `context` checkpoint the LLM judge failed, or could not be judged at all.
 *  - `assertion` — an assertion's relation came back false (Slice 19, slice 09/10). A false
 *                  relation is NEVER repairable: the test is right and the app is wrong.
 *  - `timeout`   — a step waited for something that never arrived.
 *  - `crash`     — the replay threw. An outage is not a broken locator.
 *  - `unreached` — an Agent-Driven Test left a Checkpoint Manifest slot unfilled. Not repairable
 *                  either: nothing was pinned, so there is no locator to re-pin.
 *
 * `null` for runs that finished before the column existed, and for runs that are not red.
 */
export type RunFailureKind =
  | "locator"
  | "pixel"
  | "judge"
  | "assertion"
  | "timeout"
  | "crash"
  /** An Agent-Driven Test's run left at least one Checkpoint Manifest slot unfilled — the agent
   *  never reached that state (or stopped reporting before it did). Never repairable: there is no
   *  locator to re-pin, because nothing was pinned. */
  | "unreached"
  | null;

/** The failure classes a Triage Job diagnoses — every red class except the repairable one. */
export const TRIAGE_FAILURE_KINDS = ["pixel", "judge", "assertion", "timeout", "crash"] as const;
export type TriageFailureKind = (typeof TRIAGE_FAILURE_KINDS)[number];

/** A Repair Job's kind: `repair` may change the test; `triage` only diagnoses it (slice 08). */
export type RepairJobKind = "repair" | "triage";

/**
 * A Repair Job's lifecycle. `queued` means UNCLAIMED — no drainer has taken it. A project with
 * no repair agent accumulates these, which ADR-0003 accepts as a consequence of never letting
 * Varys spend a user's Claude subscription; the queue view's job is to make it visible rather
 * than mysterious, which is why "queued" and "claimed" are distinct states and not one
 * "pending".
 */
export type RepairJobStatus = "queued" | "claimed" | "done" | "failed" | "cancelled";

/** One row of the repair queue. */
export interface RepairJobSummary {
  id: string;
  /** The test to be repaired, and its name for display without a second lookup. */
  testId: string;
  testName: string;
  /** The run whose failure created the job — null once that run has been purged. */
  runId: string | null;
  kind: RepairJobKind;
  status: RepairJobStatus;
  /** Stable identity of the broken locator: failures sharing this key share a root cause. */
  clusterKey: string;
  /** How many TESTS this job's Failure Cluster covers, and their names (Slice 19, slice 07).
   *  `testId`/`testName` above are the ANCHOR — the oldest failure, the one a drainer opens its
   *  session on. `clusterSize` is 1 for an ordinary single-test break; anything more is one app
   *  change that broke several tests and will be repaired as one reviewable fix. */
  clusterSize: number;
  clusterTestNames: string[];
  /** How many times a drainer has attempted this job. */
  attempts: number;
  /** Who holds the claim, and since when (ISO) — both null while the job is unclaimed. */
  claimedBy: string | null;
  claimedAt: string | null;
  /** When the current claim lapses (ISO), after which the job returns to the queue. Null while
   *  unclaimed — a Claim is a lease, so an in-progress job always has one. */
  claimExpiresAt: string | null;
  createdAt: string;
}

/**
 * What a drainer gets back when it claims a job (Slice 19, slice 03): everything needed to start
 * repairing without a second lookup — the test, the step that broke, and the Brief the repair
 * will have to be justified against (slice 05).
 *
 * `claimExpiresAt` is the deadline, not a hint: past it the job returns to the queue and another
 * drainer may take it, so a claimer that is still working must report before then.
 */
export interface ClaimedRepairJob {
  jobId: string;
  kind: RepairJobKind;
  testId: string;
  testName: string;
  /** The run whose failure created the job — null once that run has been purged. */
  runId: string | null;
  /** The Brief the test states its intent as (`tests.intent`), or null if it has none. */
  brief: string | null;
  clusterKey: string;
  /** Every test this job covers (Slice 19, slice 07) — the Failure Cluster, and precisely the set
   *  the claim's credential reaches. `testId` above is the anchor and is always in here. A repair
   *  applied through `apply_fix` is fanned out across all of them as ONE reviewable change, so a
   *  drainer does not (and must not) repair them one at a time. */
  clusterTests: Array<{ testId: string; testName: string; runId: string | null }>;
  /** The step that failed, as recorded on the run — null when the run has been purged. */
  failingStep: {
    index: number;
    /** Human description of the step, e.g. `click "Save changes"`. */
    label: string;
    /** The run's own error message for it. */
    error: string | null;
  } | null;
  /**
   * The ASSERTION that failed, when that is what made the run red (Slice 19, slice 10) — null
   * otherwise, and null for a run that has been purged.
   *
   * `repairable` is the whole point: an assertion whose extraction target no longer resolved is a
   * locator failure and is re-pinned like any other, while one whose relation is FALSE says the app
   * is wrong and is never repairable. `side` names which target to re-pin.
   */
  failingAssertion: {
    id: string;
    /** The plain-language check, as it read on the run that failed. */
    check: string;
    outcome: AssertionOutcome;
    cause: ExtractionCause | null;
    /** Which side could not be read — the target a repair re-pins. Null when no single side is at fault. */
    side: "left" | "right" | null;
    /** The engine's one-line account of what happened. */
    detail: string;
    /** Whether a repair may touch it at all. False ⇒ this is a diagnosis, not a fix. */
    repairable: boolean;
  } | null;
  /** Attempts INCLUDING this one, and how many remain before the job is abandoned. */
  attempts: number;
  attemptsRemaining: number;
  claimedAt: string;
  claimExpiresAt: string;
}

/**
 * What a drainer gets back when it REPORTS a repair (Slice 19, slice 04).
 *
 * The two fields that matter are the ones that say what did NOT happen: the version is
 * `unreviewed`, and `runOutcome` is still the failure that started this. A repair does not turn a
 * run green — a human accepting the version is what makes the repair real (slice 06 adds the
 * amber re-run, behind slice 05's justification gate). Saying so in the payload means a drainer
 * reports "proposed a fix, awaiting review" rather than "fixed".
 */
export interface ReportedRepair {
  ok: true;
  jobId: string;
  /** Terminal for the drainer: the job is `done` and the claim is over. */
  status: RepairJobStatus;
  testId: string;
  /** The version number the repair was written as, and its id for the review surface. */
  version: number;
  versionId: string;
  /** Always `unreviewed` — this is the whole point of the slice. */
  reviewState: VersionReviewState;
  /** The originating run and the status it still has: untouched by the repair. */
  runId: string | null;
  runStatus: string | null;
  /** The RE-RUN this repair triggered (Slice 19, slice 06) — a fresh run of the test against the
   *  repaired definition, queued the moment the justification gate let the repair stand. It is a
   *  new run, not a resurrection of `runId`: the failure that started this is history. Null when
   *  the re-run could not be queued (the repair still stands; nothing is retried automatically).
   *  For a clustered repair this is the ANCHOR's re-run; see `rerunIds`. */
  rerunId: string | null;
  /** Every test the repair was applied to (Slice 19, slice 07) and the re-run queued for each.
   *  A clustered job writes one unreviewed version per member test, all under this job, and they
   *  are accepted or rejected together — one app change, one reviewable fix. */
  clusterTestIds: string[];
  rerunIds: string[];
  /** The brief-clause justification the gate accepted, and the judge's one-line reasoning
   *  (Slice 19, slice 05). A repair only reaches this payload by passing that gate. */
  justification: string;
  justificationReasoning: string;
  note: string;
}

/**
 * What a drainer gets back when it reports a TRIAGE finding (Slice 19, slice 08).
 *
 * Every field here exists to stop a diagnosis reading as a resolution. `runOutcome` is the run's
 * outcome AFTER the finding was written — unchanged, and still red — and `versionsWritten` is
 * always 0, because a triage claim cannot write one. A drainer that reports "diagnosed" and a
 * drainer that reports "fixed" must not be able to make the same mistake.
 */
export interface ReportedTriage {
  ok: true;
  jobId: string;
  /** Terminal for the drainer: the job is `done` and the claim is over. */
  status: RepairJobStatus;
  testId: string;
  /** The run the finding was written onto, and its outcome now — still red. */
  runId: string | null;
  runStatus: string | null;
  runOutcome: RunOutcome | null;
  /** The finding as stored. */
  finding: string;
  /** Always 0. Present so the payload states it rather than leaving it to be assumed. */
  versionsWritten: 0;
  note: string;
}

/**
 * Whether a `test_version` has been through human review (Slice 19, slice 04). Everything a
 * person writes is `reviewed` on arrival; only an unattended Repair Agent writes `unreviewed`,
 * and `rejected` marks one a reviewer threw away (the test having been reverted by appending its
 * previous definition as a new version).
 */
export type VersionReviewState = "reviewed" | "unreviewed" | "rejected";

/**
 * One locator signal, on both sides of a repair (Slice 19, slice 13).
 *
 * `changed` is the whole point of the shape: a reviewer's question is never "what does this
 * locator say?" but "what did the repair MOVE?", and a signal that stayed put is the evidence
 * that it is still the same control. So both are carried, and the unchanged ones are marked as
 * such rather than dropped — a diff that only listed changes would leave a reviewer unable to
 * tell "role is still button" from "role was never recorded".
 */
export interface RepairSignalChange {
  /** Display label, e.g. `Accessible name` — the same vocabulary the locator panel uses. */
  label: string;
  /** The signal before and after, rendered flat for display. Null means "none recorded", which
   *  is itself meaningful: a DROPPED signal is as telling as a replaced one. */
  before: string | null;
  after: string | null;
  changed: boolean;
}

/** One step a repair touched, with its locator signals before and after (Slice 19, slice 13). */
export interface RepairStepDiff {
  /** 0-based index into the definition's steps — displayed as `Step n+1`. */
  stepIndex: number;
  /** What the step read as on each side (`describeStep`); equal when only signals moved. */
  beforeLabel: string;
  afterLabel: string;
  /** Every locator signal, changed or not. Empty when neither side has an element target — a
   *  navigate or a full-page checkpoint has no locator to diff. */
  signals: RepairSignalChange[];
  /** True when the step also changed OUTSIDE its locator signals (a url, a checkpoint name, a
   *  typed value). Flagged rather than rendered: a locator repair should not be doing this, and a
   *  reviewer who is only shown signals would never learn that it did. */
  nonSignalChange: boolean;
}

/**
 * What a repair actually changed, computed from the two stored definitions (Slice 19, slice 13).
 *
 * Rendered from the definitions rather than from the agent's account of itself, on purpose: an
 * agent that re-pinned "Apply filter" to "Refresh" describes its own change generously, and the
 * review gate only works if the evidence and the claim can disagree in front of the reviewer.
 */
export interface RepairChangeDiff {
  /** Only the steps that actually differ, in index order. Empty means the two definitions are
   *  identical — worth showing plainly, because a repair that changed nothing is a bug. */
  steps: RepairStepDiff[];
  /** Step counts on each side. A locator repair never adds or removes steps, so a mismatch is
   *  the first thing a reviewer should see. */
  stepCountBefore: number;
  stepCountAfter: number;
}

/**
 * One repaired version awaiting a human decision — the repair review queue (Slice 19, slices 04
 * and 13). Everything needed to decide in seconds and without navigating away: which test, which
 * version, who wrote it, the signals it moved, the Brief and the justification it was checked
 * against, the blast radius, and the page it was repaired against.
 */
export interface RepairReviewItem {
  versionId: string;
  testId: string;
  testName: string;
  /** The version awaiting review, and the version it was written on top of (what a reject
   *  reverts to). */
  version: number;
  previousVersion: number | null;
  /** Attribution — `Repair Agent "<label>" (Claude repair)` for an unattended repair. */
  createdBy: string | null;
  createdAt: string;
  /** The job this repair was reported under, and its run — null if the link is gone. */
  jobId: string | null;
  runId: string | null;
  /** What the drainer said it did, and the Brief it was meant to satisfy. */
  report: string | null;
  brief: string | null;
  /** The clause of the Brief the agent claimed this repair satisfies, and the judge's one-line
   *  verdict on that claim (Slice 19, slice 05). Shown BESIDE the brief, because a verdict is
   *  meaningless to a reviewer who cannot see what it was checked against. Null for a version
   *  written before the gate existed. */
  justification: string | null;
  justificationReasoning: string | null;
  /** Whether an INDEPENDENT judge stood behind that reasoning (Slice 19, slice 14), or the repair
   *  stands on the agent's own account because no judge is configured. Null for a version written
   *  before the distinction existed. A reviewer must be able to tell the two apart at a glance:
   *  unvalidated is not "worse", it is a different amount of evidence in front of the same
   *  decision. */
  justificationValidated: boolean | null;
  /** True while this is still the test's LATEST version — i.e. the definition runs use. A
   *  later edit having landed on top is why an accept is not automatically "this is live". */
  isActiveDefinition: boolean;
  /** The most recent run of this exact version — the re-run the repair triggered (Slice 19,
   *  slice 06) — and its derived outcome. `healed` is the answer a reviewer is looking for: the
   *  repair was exercised and everything verified. `regression`/`failed` say the repair did not
   *  actually fix it, and `queued`/`running` that the re-run is still going. Null until the
   *  re-run exists (or for a version written before re-runs did). */
  rerunRunId: string | null;
  rerunOutcome: RunOutcome | null;
  /** The Failure Cluster this repair covers (Slice 19, slice 07). `testId`/`version` above are the
   *  ANCHOR; accepting or rejecting this item decides every test named here, because one app change
   *  is one reviewable fix. `clusterSize` is 1 for an ordinary single-test repair. */
  clusterSize: number;
  clusterTestNames: string[];
  /** The side-by-side locator diff (Slice 19, slice 13), from this version's definition and the
   *  one it was written on top of. Null when there is no previous version to compare against —
   *  a first version cannot have been repaired, so this means the history was truncated. */
  diff: RepairChangeDiff | null;
  /** The page the repair was made against, captured live at the moment the fix was written
   *  (Slice 19, slice 13) — an `/artifacts/:token` URL. It is the one piece of context that is
   *  neither the agent's account nor the stored definition: a reviewer can see that the control
   *  the repair re-pinned to is the one the Brief is talking about. Null for a version written
   *  before the capture existed, or one written by `edit_test` with no live page behind it. */
  pageScreenshotUrl: string | null;
}

/**
 * The repair circuit breaker's current state (Slice 19, slice 07) — read by the queue view, so a
 * project whose jobs have stopped appearing can see WHY.
 *
 * The distinction the whole view exists for: `tripped` means Varys is deliberately refusing to
 * repair anything because too much broke at once, which is a completely different situation from
 * "nothing is draining the queue" (slice 01's unclaimed-vs-slow distinction).
 */
export interface RepairBreakerView {
  /** True while the most recent census was over threshold — repair is suppressed right now. */
  tripped: boolean;
  /** The project threshold in force, and the built-in default it falls back to. */
  threshold: number;
  defaultThreshold: number;
  /** How far back "simultaneous" reaches, in minutes. */
  windowMinutes: number;
  /** Distinct tests broken on a locator inside the window, and how many broken locators they are
   *  spread across. One cluster of forty is a rename; forty clusters is a broken app. */
  failingTests: number;
  clusters: number;
  /** Failures the breaker refused to enqueue and nobody has released yet. */
  suppressed: SuppressedFailureItem[];
}

/** One locator failure the breaker refused to enqueue, awaiting a human's decision. */
export interface SuppressedFailureItem {
  id: string;
  testId: string;
  testName: string;
  /** The run the failure was observed in — null once that run has been purged. */
  runId: string | null;
  clusterKey: string;
  /** The threshold in force, and the count that breached it, AT SUPPRESSION TIME — so the record
   *  still explains itself after somebody changes the setting. */
  threshold: number;
  failingTests: number;
  createdAt: string;
}

/** What releasing a tripped breaker did: the suppressed failures became jobs, clustered. */
export interface RepairBreakerOverride {
  ok: true;
  /** How many suppressed failures were released, and how many JOBS they collapsed into. The gap
   *  between the two numbers is the clustering doing its work. */
  released: number;
  jobsCreated: number;
  jobIds: string[];
  note: string;
}

/** The circuit-breaker threshold as the Configurations page reads and writes it. */
export interface RepairBreakerSettings {
  /** Tests simultaneously broken on a locator BEYOND which no repair job is created at all. */
  threshold: number;
  /** The built-in default, so the UI can say what "unset" means. */
  defaultThreshold: number;
  /** How far back "simultaneous" reaches, in minutes. Not editable — shown so the threshold's
   *  units are unambiguous. */
  windowMinutes: number;
}

/** The outcome of accepting or rejecting a repaired version. */
export interface RepairReviewDecision {
  ok: true;
  versionId: string;
  /** `reviewed` after an accept, `rejected` after a reject. */
  reviewState: VersionReviewState;
  /** After a reject: the new version appended to restore the previous definition. Null after
   *  an accept, which writes no version — the repaired one is already the active definition. */
  revertedToVersion: number | null;
  note: string;
}

/**
 * One Repair Agent credential as the management surface sees it (Slice 19, slice 02 / ADR-0005).
 * Never carries the token: the secret is shown exactly once, at provisioning.
 */
export interface AgentCredentialSummary {
  id: string;
  /** Human label — also what a repaired version's attribution reads. */
  label: string;
  /** The token's last 4 characters, so two credentials can be told apart. */
  tokenHint: string;
  expiresAt: string;
  revokedAt: string | null;
  /** When it was last accepted on `/mcp` — null if it has never been used. */
  lastUsedAt: string | null;
  /** `active`, or why it would be refused right now. */
  status: AgentCredentialStatus;
  /** Whether this credential may start an Agent Run Session. Off unless it was provisioned with
   *  the capability, and not editable afterwards — widening a live machine secret is a decision
   *  to re-provision for, so the audit trail says which credential was ever allowed to do it. */
  canStartAgentRuns: boolean;
  createdBy: string;
  createdAt: string;
}

/** Whether a credential would be accepted, and if not, why. */
export type AgentCredentialStatus = "active" | "expired" | "revoked";

/** Provision a credential. Expiry is required by policy, so `expiresInDays` has a default
 *  rather than an "unlimited" option. */
export interface CreateAgentCredentialRequest {
  label: string;
  expiresInDays?: number;
  /**
   * Grant this credential the ability to start an Agent Run Session. **Defaults to false.**
   *
   * Left off, the drainer sees the repair toolset and nothing else — which is the posture
   * [ADR 0005](../../../docs/adr/0005-scoped-repair-agent-credential.md) argues for, and the
   * reason `run_test` is absent from that toolset: an unattended agent that can trigger runs can
   * grind fix-and-retry until something goes green. Turn it on only for a drainer whose whole
   * job IS running agent-driven tests.
   */
  canStartAgentRuns?: boolean;
}

/** The provisioning response — the ONLY time the token is readable. */
export interface CreatedAgentCredential {
  credential: AgentCredentialSummary;
  /** The bearer token to configure on the drainer. Not retrievable afterwards. */
  token: string;
}

/** Set a Repair Policy across a scope: one test, a whole folder (including its subfolders),
 *  or a tag. Exactly one scope key is expected. */
export interface SetRepairPolicyRequest {
  policy: RepairPolicy;
  testIds?: string[];
  folderId?: string;
  tag?: string;
}

/** How many tests a bulk policy change actually applied to. */
export interface SetRepairPolicyResult {
  updated: number;
}

/**
 * A test's optional cron schedule (Slice 8 — Scheduling). Operational "when-to-run"
 * metadata, NOT part of the versioned definition: setting it writes no new test_version.
 * A row exists ⇒ the test is scheduled; `enabled` gates firing (pause without losing the
 * cron). Full shape returned by `GET /tests/:id/config`.
 */
export interface TestSchedule {
  /** Standard 5-field cron expression. */
  cron: string;
  /** IANA timezone the cron is evaluated in (e.g. "UTC", "Asia/Kolkata"). */
  timezone: string;
  /** Whether the schedule fires. Disabled keeps the cron but never runs. */
  enabled: boolean;
  /** The environment to run against; null = the default (env-less) baseline. */
  environmentId: string | null;
  /** Resolved environment name for display; null when env-less or since-deleted. */
  environmentName: string | null;
  /** Keep a Playwright trace on each scheduled run (for debuggability). */
  keepTrace: boolean;
  /** Next fire time (ISO), computed from cron+timezone; null when disabled. */
  nextRunAt: string | null;
  /** Last fire time (ISO); null until it has fired (set by the firing tick). */
  lastRunAt: string | null;
  /** The run id of the last fire (open via `?run=`); null until it has fired. */
  lastRunId: string | null;
}

/** Compact schedule badge for the Tests list — enough to render a "scheduled · next run"
 *  indicator without the full schedule. */
export interface TestScheduleSummary {
  enabled: boolean;
  cron: string;
  /** Next fire time (ISO); null when disabled. */
  nextRunAt: string | null;
}

/** The editable fields of a test's schedule, written by the test-detail config and sent
 *  under `schedule` in the structural test update (`PATCH /tests/:id`). `null` clears the
 *  schedule; omitting the field leaves it unchanged. */
export interface TestScheduleInput {
  /** Standard 5-field cron expression (validated server-side; bad cron → 400). */
  cron: string;
  /** IANA timezone; defaults to "UTC". */
  timezone?: string;
  /** Defaults to true. */
  enabled?: boolean;
  /** Environment to run against; null/omitted = default baseline. Unknown id → 404. */
  environmentId?: string | null;
  /** Defaults to false. */
  keepTrace?: boolean;
}


/** A saved test (recording), as listed in the Tests view. */
export interface TestSummary {
  id: string;
  name: string;
  createdAt: string;
  /** `pinned` (steps the worker replays) or `agent` (an Agent-Driven Test a local Claude walks).
   *  Absent on nothing — every row has one, defaulted to `pinned`. */
  kind: TestKind;
  /** Lifecycle state — the Tests view lists only `active`; drafts live in the review queue. */
  status: TestStatus;
  /** Who authored it (a promoted AI test keeps `origin: "ai"`). */
  origin: TestOrigin;
  /** Who created the test — the uploader's email for a human recording, and (since
   *  per-user MCP auth) the email of the user whose Claude Code authored an AI draft.
   *  Literal "ai" for AI drafts authored before that. Null for tests created before
   *  attribution was recorded at all. */
  createdBy: string | null;
  /** For a promoted AI draft: who promoted it into the active corpus, and when (ISO).
   *  Null for human recordings and tests promoted before attribution was recorded. */
  promotedBy: string | null;
  promotedAt: string | null;
  /** True when the test uses `{{baseUrl}}` — so it needs an environment (which supplies
   *  the base URL + cookies + localStorage) before it can run. Computed server-side from
   *  the latest version's definition. */
  needsEnvironment: boolean;
  /** The test's folder (organization metadata, relational — never part of the
   *  versioned definition). Null = Unfiled. */
  folderId: string | null;
  folderName: string | null;
  /** Free-form tags (many-to-many slicing across folder boundaries). */
  tags: string[];
  /** The test's cron schedule, or null when unscheduled — drives the Tests-list
   *  "scheduled · next run" indicator (Slice 8). */
  schedule: TestScheduleSummary | null;
  /** What happens when a run of this test fails on an unresolvable locator (Slice 19).
   *  `manual` for everything until an author opts in. */
  repairPolicy: RepairPolicy;
}

/**
 * A wait primitive as surfaced for the test-config editor. Mirrors the step schema's
 * wait union (kept here as a pure type, like Rect/CaptureMode, so the SPA needs no
 * step-schema/zod dependency). `delay`, `networkIdle`, and `streamIdle` are authorable in the
 * editor; `selector` is display-only in v1 — shown as a locked row and preserved untouched on
 * save (its target is summarized as `targetLabel`).
 */
export type ConfigWait =
  | { kind: "delay"; ms: number }
  | { kind: "networkIdle"; timeoutMs?: number }
  | { kind: "streamIdle"; quietMs?: number; timeoutMs?: number }
  | { kind: "selector"; state: "visible" | "hidden"; timeoutMs?: number; targetLabel: string };

/** The subset of waits the editor writes back. Selector waits are NOT editable in v1
 *  (the server preserves them), so only the number-only kinds appear here. */
export type EditableWait =
  | { kind: "delay"; ms: number }
  | { kind: "networkIdle"; timeoutMs?: number }
  | { kind: "streamIdle"; quietMs?: number; timeoutMs?: number };

/** One step as the test-config editor renders it — label + the waits before it, plus
 *  the screenshot-only knobs (threshold). Every step type carries its own `waitBefore`;
 *  `defaultWaitsApply` says whether the test-level defaults run ahead of them too. */
export interface TestConfigStep {
  /** 0-based position in the definition's step list — the key a patch addresses this step by.
   *  Not stable across a patch that adds, removes or reorders steps: re-read the config after
   *  one of those before keying another edit off an index. */
  index: number;
  type: "navigate" | "click" | "hover" | "type" | "screenshot";
  /** Human label (same `describeStep` vocabulary as the run timeline). */
  label: string;
  /** Whether the test-level `defaults.waitBefore` run ahead of this step's own waits. False for
   *  navigate — a navigation carries only what its author put on it. */
  defaultWaitsApply: boolean;
  /** The waits the runner applies before this step (after the test-level defaults, where those
   *  apply). On a navigate they run before the `goto`, settling the page being left. */
  waitBefore: ConfigWait[];
  /** Navigate-only: the URL this step navigates to (tokenized, e.g. `{{baseUrl}}/reports`);
   *  null for every other step type. */
  url: string | null;
  /** Screenshot-only: the checkpoint name; null for non-screenshot steps. */
  checkpointName: string | null;
  /** Screenshot-only: how it's captured. */
  captureMode: CaptureMode | null;
  /** Screenshot-only, `region` capture: the clipped rectangle. Null otherwise. */
  rect: Rect | null;
  /** Screenshot-only: how it's compared to its baseline (`pixel` diff or `context` LLM judge);
   *  null for non-screenshot steps. */
  compareMode: CompareMode | null;
  /** Screenshot-only: the author-written judge prompt when `compareMode` is `context`; null for
   *  pixel checkpoints and non-screenshot steps. */
  prompt: string | null;
  /** Screenshot-only: the explicit per-checkpoint threshold, or null when it inherits
   *  the runner default (shown as a placeholder in the editor). Pixel-mode only. */
  threshold: number | null;
  /** Type-only: the literal value typed into the field (editable on Test Detail). Null for
   *  non-type steps. */
  value: string | null;
  /** The step's element locator, surfaced as editable signals — present for click, type,
   *  and element-mode screenshot steps; null for navigate and full-page / region
   *  screenshots (which have no element target). Edited via `TestConfigStepPatch.target`. */
  target: FingerprintSummary | null;
  /** Screenshot-only: the diff-ignore mask regions (screenshot-pixel space). Empty for
   *  non-screenshot steps. Edited on Test Detail by drawing on `baselineUrl`. */
  masks: Rect[];
  /** Screenshot-only: a baseline image to draw masks on (the checkpoint's current golden —
   *  default environment preferred, else any). Null when no baseline has been approved yet,
   *  or for non-screenshot steps. */
  baselineUrl: string | null;
}

/**
 * The editable subset of a locator's signals (the "click string"). Each PRESENT key sets
 * that signal; an empty string CLEARS it; an OMITTED key leaves it unchanged. Every other
 * captured fingerprint signal (ancestors, classes, scope, bounding box, structural path) is
 * preserved server-side — editing a locator never collapses it to a single selector.
 */
export interface FingerprintPatch {
  role?: string;
  accessibleName?: string;
  text?: string;
  testId?: string;
  /** A raw selector override (CSS or Playwright selector). Set ⇒ used as-is when it
   *  resolves uniquely; "" clears it; omitted leaves it unchanged. (Slice 16.2.) */
  selectorOverride?: string;
}

/** Request body for the live locator-verify probe (Slice 16.3a): check a CANDIDATE
 *  (unsaved) locator at one step against a chosen environment, via a transient partial
 *  replay. `environmentId` is omitted/null for a no-variable test (verifies env-less). */
export interface LocatorVerifyRequest {
  /** 0-based index of the step whose locator is being checked. */
  stepIndex: number;
  /** Environment to resolve {{tokens}} against; null/omitted = env-less ("default"). */
  environmentId?: string | null;
  /** The candidate locator edit, merged onto the step's fingerprint before resolving. */
  target: FingerprintPatch;
}

/** Result of the live locator-verify probe. `status` is the matcher's verdict at the step;
 *  `reachedStep` is how far the drive got (= the requested step on full reach). When the
 *  drive failed BEFORE the step, `failedStepIndex`/`failedStepLabel` name the broken step
 *  (so "wrong locator" is distinguishable from "broken path to the step"). */
export interface LocatorVerifyResult {
  status: "resolved" | "ambiguous" | "not-found";
  /** The signal that identified the match (e.g. `testId`, `role+name`, `override`); null
   *  unless `status` is `resolved`. */
  matchedSignal: string | null;
  /** True when the match leaned on a weaker signal than the locator's strongest. */
  healed: boolean;
  /** How far the drive reached (the index it resolved/failed at). */
  reachedStep: number;
  /** The step the drive could not perform, when it failed before reaching the target; null
   *  when the drive reached the target step. */
  failedStepIndex: number | null;
  failedStepLabel: string | null;
}

/** The test-config read-model — the latest version's editable surface (waits +
 *  threshold). Produced by `GET /tests/:id/config`. */
export interface TestConfigView {
  id: string;
  name: string;
  /** Which kind of test this is. `agent` has no steps to configure at all — its behaviour is its
   *  AI Instructions plus its ordered Checkpoints, edited in place and never versioned — so the
   *  detail page branches on this rather than rendering an empty step editor. */
  kind: TestKind;
  /** The latest version number this config reflects — echoed back as `baseVersion`
   *  in a save so the server can reject a stale edit (optimistic concurrency). */
  version: number;
  /** Test-level default waits applied before every wait-supporting step. */
  defaults: ConfigWait[];
  steps: TestConfigStep[];
  /** The test's cron schedule, or null when unscheduled (Slice 8). Edited in the
   *  test-detail config surface and written back via the structural `PATCH /tests/:id`. */
  schedule: TestSchedule | null;
  /** Optional free-form note on the test, or null when none. Written via `PATCH /tests/:id`. */
  notes: string | null;
  /**
   * The test's BRIEF (`tests.intent`) — the author's statement of what this test is for, or null
   * when it has none. Editable here, and written via the structural `PATCH /tests/:id`, so
   * changing it writes NO new test_version: the Brief says what the test is for, not what it
   * does, and re-stating it must not disturb the test's history or its baselines.
   *
   * Load-bearing since Slice 19 slice 05: an automated repair has to be justified against a
   * clause of this, and a test with no Brief cannot be repaired automatically at all.
   */
  brief: string | null;
  /** True when the test uses `{{baseUrl}}` — the locator-verify control uses this to require
   *  an environment (which supplies the base URL + cookies + localStorage). */
  needsEnvironment: boolean;
  /** The test's Repair Policy (Slice 19). Shown and edited on test detail; written via the
   *  structural `PATCH /tests/:id`, so changing it never writes a new test_version. */
  repairPolicy: RepairPolicy;
  /**
   * The wall-clock lease an Agent Run Session on this test is given, in seconds — the bound on an
   * agent that will not stop. Meaningful only for `kind: "agent"`; a pinned test carries the
   * default and ignores it. Written via the structural `PATCH /tests/:id`, so changing it writes
   * no test_version — the lease is operational metadata, like the Repair Policy.
   */
  agentLeaseSeconds: number;
  /** The test's declared Assertions (slice 09), with their pinned form spelled out — which
   *  elements each side reads and what is compared. Empty for a test that declares none. */
  assertions: TestConfigAssertion[];
}

/**
 * A recorded element fingerprint travelling on a patch — the `Fingerprint` of
 * `@varys/step-schema`, typed loosely here so this contract stays dependency-free (it is
 * consumed by the SPA, which must not pull in the schema package). Everything assembled from
 * one is Zod-validated against the real schema server-side before it is stored, so the loose
 * type never reaches the database.
 */
export type RecordedTarget = Record<string, unknown>;

/** A per-step edit in a config patch — keyed by `index`. Omitted fields are left as-is. */
export interface TestConfigStepPatch {
  index: number;
  /** Remove this step from the definition entirely. The entry navigation (index 0) can't
   *  be removed; when set, the step's other patch fields are ignored. */
  remove?: boolean;
  /** Screenshot-only: RENAME the checkpoint. The name is part of the baseline key, so the
   *  server moves this test's baselines and draft previews onto the new name in the same
   *  transaction as the version write — a rename re-points the golden rather than orphaning
   *  it. Names must stay unique within the test. */
  name?: string;
  /** Screenshot-only: switch how the checkpoint is CAPTURED. `element` needs a target (the
   *  step's own, or one supplied via `recapture`), `region` needs a `rect`, `fullpage`
   *  needs neither. */
  captureMode?: CaptureMode;
  /** Screenshot-only: the clipped rectangle for `region` capture. */
  rect?: Rect;
  /** Navigate-only: set the URL this step navigates to. Keep the `{{baseUrl}}` token to
   *  stay environment-agnostic. */
  url?: string;
  /** REPLACE this step's element locator with a freshly captured fingerprint, rather than
   *  patching signals onto the recorded one. This is how a repair session re-records a step
   *  against the live page when the element changed wholesale. `target` (the signal patch)
   *  is applied on top of it. */
  recapture?: RecordedTarget;
  /** Replace this step's authorable (delay/networkIdle) waits; any existing selector
   *  waits are preserved server-side. */
  waitBefore?: EditableWait[];
  /** Screenshot-only: switch pixel ↔ context comparison. Setting `context` requires a `prompt`
   *  (on this patch or already on the step), else the save is rejected. */
  compareMode?: CompareMode;
  /** Screenshot-only: set the `context` judge prompt. */
  prompt?: string;
  /** Screenshot-only: set the per-checkpoint threshold (0..1). Pixel-mode only. */
  threshold?: number;
  /** Screenshot-only: replace this checkpoint's diff-ignore mask regions (full list). */
  masks?: Rect[];
  /** Drop recorded `selector` waits by their 0-based position among this step's selector waits
   *  (the order shown as locked rows in the editor). Normally selector waits are preserved on save;
   *  this lets the editor remove one. Absent = keep all. */
  dropLockedWaits?: number[];
  /** Type-only: set the literal value typed into the field. */
  value?: string;
  /** Edit the step's element locator signals (click / type / element-mode screenshot).
   *  Merged onto the existing fingerprint; other signals are preserved. */
  target?: FingerprintPatch;
}

/** A manually-added step (test-detail "add step", or an MCP `edit_test` insert).
 *  - `navigate` (URL) and full-page `screenshot` (checkpoint name) need no recorded element.
 *  - `click`/`hover`/`type` are authored EITHER by a raw CSS/Playwright `selector` (stored as
 *    the locator's `selectorOverride` — no multi-signal bundle behind it, so a stale selector
 *    fails the step with no self-heal) OR by a `target` captured live off a real element,
 *    which carries the full fingerprint and self-heals exactly like a recorded step. A repair
 *    session supplies the latter from a page ref; the web editor supplies the former. */
export type NewStepInput =
  | { type: "navigate"; url: string }
  | {
      type: "screenshot";
      name: string;
      /** Defaults to `fullpage` — the only mode authorable without an element. `element`
       *  requires a `target`/`selector`; `region` requires a `rect`. */
      captureMode?: CaptureMode;
      rect?: Rect;
      selector?: string;
      target?: RecordedTarget;
      compareMode?: CompareMode;
      prompt?: string;
      threshold?: number;
      masks?: Rect[];
    }
  | { type: "click"; selector?: string; target?: RecordedTarget }
  | { type: "hover"; selector?: string; target?: RecordedTarget }
  | { type: "type"; selector?: string; target?: RecordedTarget; value: string };

/** An insertion in a config patch: place a new step relative to an existing step, addressed by
 *  its ORIGINAL 0-based index in the opened definition. Inserting `above` the entry navigation
 *  (index 0) is rejected server-side — replay must start by navigating. */
export interface TestConfigStepInsert {
  atIndex: number;
  position: "above" | "below";
  step: NewStepInput;
}

/** The body of `PUT /tests/:id/config`: a targeted patch the server applies onto the
 *  latest definition, writing a new audited test version. */
export interface TestConfigPatch {
  /** The version the edit was based on — the server returns 409 if a newer one exists. */
  baseVersion: number;
  /** Replace the test-level default waits (authorable kinds only). Omit to leave as-is. */
  defaults?: EditableWait[];
  /** Per-step edits. Omit to leave all steps as-is. */
  steps?: TestConfigStepPatch[];
  /** Steps to insert, each anchored to an existing step's original index. Applied after
   *  removals/edits. Omit when nothing is being added. */
  inserts?: TestConfigStepInsert[];
  /** REORDER the steps: a permutation of the ORIGINAL 0-based indices, in their new order.
   *  It must list exactly the steps that survive this patch (every original index except the
   *  ones being removed), and the entry navigation must stay first. Inserts stay anchored to
   *  the step they name, so they follow it to its new position. Omit to keep the recorded
   *  order. */
  order?: number[];
  /** Per-assertion edits, keyed by the assertion's stable `id`. Omit to leave them as-is. */
  assertions?: TestConfigAssertionPatch[];
}

/**
 * An edit to one declared assertion, keyed by its id.
 *
 * The id is the key and is never patchable: it is the identity the assertion's history hangs off,
 * so "rename the id" is deleting one assertion and declaring another, and must read that way.
 */
export interface TestConfigAssertionPatch {
  id: string;
  /** Rewrite the plain-language check. The id — and therefore the history — is untouched. */
  check?: string;
  /**
   * RE-PIN the left side's extraction target: a locator patch merged onto the recorded
   * fingerprint, exactly as a step's `target` patch is (Slice 19, slice 10). This is what repairs
   * an assertion whose target no longer resolves — a locator failure like any other. Refused for an
   * assertion with no pinned form, and for a side that is a literal.
   */
  left?: FingerprintPatch;
  /** RE-PIN the right side's extraction target. See {@link TestConfigAssertionPatch.left}. */
  right?: FingerprintPatch;
  /** Delete this assertion. When set, the other fields are ignored. */
  remove?: boolean;
}

/** Result of a config save: the version number of the newly written test_version. */
export interface SaveConfigResult {
  version: number;
}

/**
 * One row in the AI-authored Draft review queue (`GET /drafts`, Slice 14). A draft is a
 * first-class test held out of suites/schedules until a human reviews and promotes it.
 */
export interface DraftSummary {
  id: string;
  name: string;
  origin: TestOrigin;
  createdAt: string;
  /** Which kind of test this Draft is. The queue branches on it: a pinned Draft's checkpoints
   *  are recorded screenshot steps, an Agent-Driven one's are Checkpoint rows, and reading the
   *  wrong source reports a test that asserts eight things as asserting nothing. */
  kind: TestKind;
  /** How many checkpoints the draft asserts — 0 ⇒ flagged (a test that asserts nothing).
   *  Counted from whichever source this Draft's {@link kind} keeps them in. */
  checkpointCount: number;
  /** The steering instruction that produced the draft, if any (review-queue context). */
  intent: string | null;
  /** A representative authoring-preview thumbnail (the first checkpoint's screenshot Claude
   *  captured), or null when the draft has no preview. A reference image, NOT the golden
   *  baseline — the pinned runner seeds that on first replay (DESIGN §4). */
  previewUrl: string | null;
}

/** One checkpoint's authoring preview — the reference screenshot Claude captured during
 *  authoring, shown in the promote dialog so the reviewer sees what the test will assert. */
export interface DraftCheckpointPreview {
  name: string;
  /** How the shot was framed. Null on an Agent-Driven Draft: Varys did not take the picture and
   *  has no opinion about how it was framed — the agent captured it with its own tooling. */
  captureMode: CaptureMode | null;
  /** Authenticated artifact-route URL of the preview PNG; null if none was captured. */
  previewUrl: string | null;
  /** Agent-Driven only: how a run reaches this state, and what counts as matching its baseline —
   *  the prose a reviewer is actually judging. Null on a pinned Draft, whose checkpoint is a
   *  recorded step and carries no instructions of its own. */
  instructions: string | null;
  comparePrompt: string | null;
}

/** The full Draft detail (`GET /drafts/:id`) — the summary plus every checkpoint's
 *  authoring preview, for a richer pre-promotion view. */
export interface DraftView {
  id: string;
  name: string;
  origin: TestOrigin;
  createdAt: string;
  kind: TestKind;
  /**
   * The Brief, whose meaning depends on {@link kind} and is not the same thing twice.
   *
   * On a pinned Draft it is the **steering instruction** — the sentence that asked for the test,
   * recorded as review-queue context. On an Agent-Driven one it is the **AI Instructions** Claude
   * authored: the artifact itself, composed into every future run. The steering prompt is
   * deliberately not persisted for that kind, precisely so this slot can hold the artifact.
   */
  intent: string | null;
  checkpoints: DraftCheckpointPreview[];
}

/** Body of `POST /drafts/:id/promote` — assign a folder + tags and make the test active
 *  (suite/schedule eligible). Promotion is web-UI only and never an agent tool. */
export interface PromoteDraftBody {
  /** The folder to file the promoted test into; null/omitted leaves it unfiled. */
  folderId?: string | null;
  /** Tags to apply on promotion (full-list replace, normalized). */
  tags?: string[];
}

/**
 * How an Authoring Session is being driven (Author with AI):
 *  - `interactive` — step-by-step: Claude performs one action per instruction, then waits.
 *  - `batch` — Claude runs a whole plan/file to completion in one go.
 * Chosen when the session opens (`open_session`'s `mode`); steers Claude's behavior and the
 * checkpoint cadence, and drives a badge in the live view. Defaults to `interactive`.
 */
/** How an Authoring Session is being driven. `interactive` / `batch` RECORD a new test;
 *  `repair` records nothing — it re-drives an existing test's steps to the point a Run failed
 *  and parks there so a locator can be diagnosed against the live page. */
export type AuthoringMode = "interactive" | "batch" | "repair";

/**
 * The AI authoring instructions (the MCP `initialize` prompt), as read/edited from the Author
 * page (`GET/PUT /authoring/instructions`). Two layers, served to Claude as `base` + `additional`:
 *  - `base` — the foundational prompt (modes, checkpoint discipline, core rules). Changed rarely;
 *    edited in an "advanced" section. `baseUsingDefault` is true when no override is stored (so
 *    `base` is the baked-in `baseDefault`, the reset target).
 *  - `additional` — team-specific guidance, edited frequently and appended under its own heading.
 *    When `additionalLockedByEnv` is true it's supplied via env (a deployment lock) and read-only
 *    here. Changes apply on the next Claude Code connect.
 */
export interface AuthoringInstructionsView {
  base: string;
  baseUsingDefault: boolean;
  baseDefault: string;
  additional: string;
  additionalLockedByEnv: boolean;
}

/**
 * Global image-comparison defaults, edited on the Configurations page and applied to every
 * checkpoint diff (a single test can still override the per-checkpoint threshold). The two knobs
 * run in sequence: `perPixel` decides which pixels count as changed; `ratio` decides how many of
 * those changed pixels are tolerated before the checkpoint is flagged. Both are fractions in
 * [0, 1]. Persisted in `app_settings`; a missing value falls back to the defaults below.
 * Produced/consumed by `GET`/`PUT /settings/image-comparison`.
 */
export interface ImageComparisonSettings {
  /** How different a single pixel's colour must be to count as changed, as a fraction of the
   *  maximum colour distance (0 = exact match required, 1 = ignore colour entirely). */
  perPixel: number;
  /** The share of changed pixels a checkpoint may contain before it's flagged (0 = any change
   *  fails). The rest of Varys calls this simply "the threshold". */
  ratio: number;
}

/** Default per-pixel colour sensitivity — the long-standing hardcoded `pixelmatch` value. */
export const DEFAULT_PER_PIXEL_THRESHOLD = 0.1;
/** Default allowed-change ratio — 1% of pixels may differ before a checkpoint is flagged. */
export const DEFAULT_RATIO_THRESHOLD = 0.01;

/** The effective defaults when nothing is stored — the shape `GET /settings/image-comparison`
 *  returns on a fresh install. */
export const DEFAULT_IMAGE_COMPARISON_SETTINGS: ImageComparisonSettings = {
  perPixel: DEFAULT_PER_PIXEL_THRESHOLD,
  ratio: DEFAULT_RATIO_THRESHOLD,
};

/** The LLM providers the context-compare judge can use (Configurations dropdown). `gemini` uses
 *  Google's free-tier vision models; `openai` is any OpenAI-compatible endpoint (Ollama, OpenRouter,
 *  …) via a custom `baseUrl`. */
export type JudgeProviderName = "anthropic" | "gemini" | "openai";
export const JUDGE_PROVIDERS: { value: JudgeProviderName; label: string }[] = [
  { value: "gemini", label: "Google Gemini (free tier)" },
  { value: "anthropic", label: "Anthropic Claude" },
  { value: "openai", label: "OpenAI-compatible (custom)" },
];

/**
 * The judge (context-compare) config as the Configurations page reads it. The API **never returns
 * the API key** — only whether one is stored and a short hint (last 4 chars) so the user can
 * recognise which key is set. Produced by `GET /settings/judge`.
 */
export interface JudgeSettingsView {
  provider: JudgeProviderName;
  model: string;
  /** Custom OpenAI-compatible endpoint (only meaningful for provider `openai`); null otherwise. */
  baseUrl: string | null;
  /** Whether an API key is stored. */
  apiKeySet: boolean;
  /** Last 4 chars of the stored key, or null when unset — a recognition hint, never the full key. */
  apiKeyHint: string | null;
  /** The default judge prompt applied to every `context` checkpoint that doesn't set its own. Empty
   *  string when unset — a context checkpoint with neither its own prompt nor this fails at run time. */
  defaultPrompt: string;
}

/** Config-page edit for the judge. Omitted fields are left untouched; a non-empty `apiKey` replaces
 *  the stored key (an omitted/empty key leaves the existing one in place). Consumed by
 *  `PUT /settings/judge`. */
export interface JudgeSettingsPatch {
  provider?: JudgeProviderName;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  /** The default judge prompt inherited by context checkpoints that set none. */
  defaultPrompt?: string;
}

/**
 * Slack completion-notification config (Configurations page). When enabled + configured, the
 * worker posts a message to `channel` after every run finishes — a single test (manual or
 * scheduled) and, via fan-in, once per suite run. Masked on read (never returns the bot token).
 */
export interface SlackSettingsView {
  /** Per-source toggles — the ONLY on/off control (no separate master switch): Slack is "on" when
   *  any source is enabled and a token+channel are set; all-off = no notifications. Manual =
   *  on-demand runs (the Run button / API); scheduled = cron test-schedules; suite = a suite run's
   *  single fan-in summary (manual or cron). Each defaults ON. */
  notifyManual: boolean;
  notifySchedule: boolean;
  notifySuite: boolean;
  /** Attach a rendered PDF flow-report to each notification (needs the bot's `files:write` scope). */
  attachPdf: boolean;
  /** Target channel (id like `C0…` or a `#name`). */
  channel: string;
  /** Base URL of the Varys web app, used to build the "View run" deep link; null when unset
   *  (the message then omits the link). */
  baseUrl: string | null;
  /** Whether a bot token is stored. */
  tokenSet: boolean;
  /** Last 4 chars of the stored token, or null when unset — a recognition hint, never the token. */
  tokenHint: string | null;
}

/** Editable Slack config — an omitted or blank field is left untouched; a non-empty `token`
 *  replaces the stored one (a blank token never clears it, so re-saving the masked form keeps it). */
export interface SlackSettingsPatch {
  notifyManual?: boolean;
  notifySchedule?: boolean;
  notifySuite?: boolean;
  attachPdf?: boolean;
  channel?: string;
  baseUrl?: string;
  /** The Slack bot token (`xoxb-…`). Write-only — never returned by the masked view. */
  token?: string;
}

/**
 * One active Authoring Session, as listed for the live-preview picker
 * (`GET /authoring/sessions`, Slice 15 — Author with AI). An Authoring Session is the live
 * server-side browser Claude drives; this is just enough to identify and choose one to watch.
 */
export interface AuthoringSessionSummary {
  sessionId: string;
  /** The name of the test being authored. */
  name: string;
  /** The steering intent that opened the session, if any. */
  intent: string | null;
  /** Whether the session is being driven step-by-step or as a batch plan. */
  mode: AuthoringMode;
  /** The session's current page URL and title. */
  url: string;
  title: string;
  /** Recorded steps and proposed checkpoints so far. */
  stepCount: number;
  checkpointCount: number;
}

/**
 * A live frame of an Authoring Session — a page screenshot captured after a mutating tool
 * (click / type / navigate / checkpoint), streamed to the web live-preview pane
 * (`GET /authoring/sessions/:id/stream`, Slice 15). Decoupled from the model's perception: the
 * agent only "sees" a screenshot when it calls `observe(screenshot:true)`; these frames are a
 * human-only channel and are never sent to the model (so watching costs no inference).
 */
export interface AuthoringFrame {
  sessionId: string;
  /** Monotonic per-session sequence number (ordering / dedup). */
  seq: number;
  url: string;
  title: string;
  /** Page screenshot as a data URL (`data:image/png;base64,…`), ready for an `<img src>`. */
  screenshot: string;
  /** What was just recorded into the test. */
  recorded: { type: string; checkpoint?: string };
  /** Recorded steps and proposed checkpoints after this frame. */
  stepCount: number;
  checkpointCount: number;
}

/**
 * Emitted on the live stream when an Authoring Session finishes and its steps are persisted as a
 * Draft (Slice 15). The web uses it to hand off to the review queue — "Draft created → Review it"
 * — the moment authoring completes.
 */
export interface AuthoringDraftEvent {
  sessionId: string;
  /** The created Draft test id. */
  testId: string;
  version: number;
  checkpointCount: number;
  /** The authored test's name. */
  name: string;
}

/**
 * A Bridge that links a user's local Bridge Helper to their in-product chat (Slice 15 — Author
 * with AI). One bridge = one chat = one Authoring Session. Created by the signed-in web user;
 * the helper claims the short `pairingCode` out-of-band to obtain a chat-scoped token.
 */
export interface BridgeChatState {
  chatId: string;
  /** Short, one-time pairing code shown in the web UI to link the helper; null once the helper
   *  has paired or the code has expired. */
  pairingCode: string | null;
  /** Unix ms when the pairing code expires; null once paired/expired. */
  pairingExpiresAt: number | null;
  /** Whether a Bridge Helper is currently connected to this chat. */
  helperConnected: boolean;
  /** The correlated Authoring Session id (drives the slice-01 live preview); null until the
   *  helper binds one. */
  sessionId: string | null;
}

/** Result of claiming a pairing code (`POST /authoring/bridge/pair`) — returned ONLY to the
 *  helper. `bridgeToken` is a chat-scoped secret the helper presents on its stream/event calls. */
export interface BridgePairResult {
  chatId: string;
  bridgeToken: string;
}

/** An event mirrored into the web chat (server → web). The relay owns `status`; `assistant` and
 *  `tool` are forwarded from the Bridge Helper. */
export type BridgeEvent =
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "status"; helperConnected: boolean; sessionId: string | null };

/**
 * A command the web sends down to the Bridge Helper (server → helper).
 *
 *  - `prompt` — a chat turn for **Author with AI** (Slice 15).
 *  - `run-agent-test` — start an **Agent Run Session** on an Agent-Driven Test (Slice 17). It
 *    carries the test id and the chosen environment id and NOTHING else: no AI Instructions, no
 *    Checkpoint Manifest, no baselines. Those are what `start_agent_run` returns, and a second
 *    copy travelling down here is a second copy that can disagree with the first. Naming the test
 *    by id rather than by a sentence is the whole point — it removes the class of failure where a
 *    typed prompt reaches a different test than the one that was clicked.
 *
 * `environmentId` is `null` when the request named no environment. Null means "none was chosen",
 * never "pick one" — the helper passes it straight through, and `start_agent_run` resolves the
 * `default` fallback exactly as it does for a session started by hand.
 *
 * cancel/interrupt arrive in a later slice.
 */
export type BridgeCommand =
  | { type: "prompt"; text: string }
  | { type: "run-agent-test"; testId: string; environmentId: string | null };

/**
 * Whether the signed-in user has a **Bridge Helper** on the other end of a command stream right
 * now — what the Run control on an Agent-Driven Test is live or disabled by.
 *
 * Owner-scoped and process-local, like the rest of the relay's state. A user with several chats
 * open has several helpers; `chatId` names the one a run request would travel down (the most
 * recently connected), so the answer and the destination cannot drift apart.
 */
export interface BridgeHelperPresence {
  /** True when at least one bridge this user owns has a helper holding its command stream. */
  helperConnected: boolean;
  /** The chat a run request would reach, or null when no helper is paired. */
  chatId: string | null;
}

/** Asking Varys to ask your own Claude to run an Agent-Driven Test (web → server). Omit
 *  `environmentId` to run against no environment. */
export interface AgentRunRequestBody {
  testId: string;
  environmentId?: string;
}

/**
 * Where a run request is in its short life (Slice 18). The press writes nothing durable, so this
 * is the web app's only account of what is happening between the press and the Run appearing.
 *
 *  - `none` — no request on record for this test (never sent, or long since forgotten).
 *  - `outstanding` — sent to a helper; nothing has come back yet.
 *  - `acknowledged` — the helper reported that it has launched Claude. The press is known to have
 *    landed somewhere, which is what distinguishes a slow helper from a wedged one.
 *  - `fulfilled` — a Run for this test was started. The thing the author actually wanted.
 *  - `lapsed` — neither happened inside the bound. Not an error condition of anything: it is the
 *    honest report that Varys asked and cannot say whether anybody listened.
 */
export type AgentRunRequestPhase =
  | "none"
  | "outstanding"
  | "acknowledged"
  | "fulfilled"
  | "lapsed";

/**
 * Whether a request is still open — the two phases during which a further press for the same test
 * is refused, and the only two from which it can still become anything else. Shared rather than
 * spelled out at each site, so the button's idea of "in flight" and the relay's cannot drift.
 */
export function isAgentRunRequestInFlight(phase: AgentRunRequestPhase): boolean {
  return phase === "outstanding" || phase === "acknowledged";
}

/**
 * The transient, owner-scoped state of one run request. Nothing here is durable and none of it
 * survives a restart — a request that lapses leaves nothing behind, because nothing was created.
 */
export interface AgentRunRequestState {
  testId: string;
  phase: AgentRunRequestPhase;
  /** Unix ms the request was sent; null when `phase` is `none`. */
  requestedAt: number | null;
  /** Unix ms this request lapses at if no Run appears. Null once it is `fulfilled` or `lapsed` —
   *  there is no longer anything to count down to. */
  lapsesAt: number | null;
  /** Unix ms the helper said it had launched Claude, or null if it never did. Read alongside
   *  `lapsed` it is the difference between "nobody answered" and "Claude was started and no run
   *  came of it" — two different things to go and look at. */
  acknowledgedAt: number | null;
  /** The Run that fulfilled this request — where the web app takes the author. */
  runId: string | null;
}

/** Which paired helper the run request was handed to, and the life that request now has. */
export interface AgentRunRequestResult {
  chatId: string;
  request: AgentRunRequestState;
}

/** What the Bridge Helper POSTs up to the relay (helper → server). `assistant`/`tool` are
 *  mirrored to the web verbatim; `session` correlates the Authoring Session and the relay turns
 *  it into a `status` event.
 *
 *  `agent-run-launched` is the helper saying it has started Claude on a run request. The relay
 *  keeps it rather than mirroring it, because it answers a request rather than adding a line to
 *  the conversation. It is a claim about the helper's own behaviour and nothing more: it says a
 *  Claude was launched, never that a Run exists — only `start_agent_run` can say that. */
export type BridgeHelperEvent =
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "session"; sessionId: string }
  | { type: "agent-run-launched"; testId: string };

/**
 * Whether Claude Code is driving the MCP authoring server (Slice 15). The MCP transport is
 * **stateless HTTP** — each tool call is a separate POST with no held connection — so this is an
 * *activity* signal (a request seen within the recent window), not a literal socket state.
 */
export interface McpStatus {
  /** True when an MCP request was seen within the recent-activity window. */
  connected: boolean;
  /** Unix ms of the last MCP request seen this server process, or null if none yet. */
  lastSeenAt: number | null;
}

/** A folder — each test's one browsable home (DESIGN §5). Folders nest via `parentId`. */
export interface FolderSummary {
  id: string;
  name: string;
  /** Parent folder id, or null for a root folder. */
  parentId: string | null;
  /** How many tests live DIRECTLY in this folder (not counting subfolders). */
  testCount: number;
}

/** A suite — a named, saved selection of tests: the run unit slice 6 executes as
 *  `suite × env(s)` (DESIGN §5). This slice defines and manages them only. */
export interface SuiteSummary {
  id: string;
  name: string;
  /** How many tests the suite currently selects — the EFFECTIVE count: the selected folders'
   *  tests (and subfolders') plus individually-selected tests, deduped. */
  testCount: number;
  /** How many whole folders the suite includes. */
  folderCount: number;
  /** Who created the suite (email); null for suites created before attribution. */
  createdBy: string | null;
}

/** A suite with its EFFECTIVE member tests (full summaries) plus the raw selection so the editor
 *  can restore exactly what was picked. A suite selects any mix of whole folders (dynamic — all
 *  tests in the folder + subfolders) and individual standalone tests. */
export interface SuiteView {
  id: string;
  name: string;
  /** Who created the suite (email); null for suites created before attribution. */
  createdBy: string | null;
  /** The folders the suite includes (raw selection — restores the editor's folder checkboxes). */
  folderIds: string[];
  /** The individually-selected standalone tests (raw selection). */
  testIds: string[];
  /**
   * The suite's AI Instructions — the outermost of the three layers, prepended to every
   * Agent-Driven member's composed instructions. Null when the suite carries none.
   *
   * Environmental context, not behavioural overrides: which app, which account, what to ignore.
   * It reaches no PINNED member, because a pinned test is replayed by the worker with no model
   * call and has nothing to read it.
   */
  agentInstructions: string | null;
  /** The effective, deduped member tests (folders resolved + standalone), newest first. */
  tests: TestSummary[];
  /** The suite's cron schedule (fires a whole suite run), or null when unscheduled. `lastRunId`
   *  holds the last fired **suite_run** id. Reuses the TestSchedule shape. */
  schedule: TestSchedule | null;
}

/**
 * A cookie seeded into the browser context BEFORE a run, so a test that needs an
 * existing session/consent cookie starts with it already set. `value` supports the
 * same `{{var}}` / `{{secret:NAME}}` tokens steps do — keep a real auth token in a
 * write-only secret and reference it here rather than pasting it in plain.
 */
export interface EnvCookie {
  /** Cookie name. */
  name: string;
  /** Cookie value (literal). */
  value: string;
  /** Cookie domain. Defaults to the environment's `baseUrl` host when omitted. */
  domain?: string;
  /** Cookie path. Defaults to `/`. */
  path?: string;
}

/**
 * A localStorage entry seeded into the browser BEFORE a run, so a test that needs an
 * existing token/flag stored in `window.localStorage` (e.g. an auth JWT or a "seen the
 * onboarding" flag) starts with it already present.
 */
export interface EnvLocalStorageItem {
  /** localStorage key. */
  key: string;
  /** localStorage value (literal). */
  value: string;
  /** Origin (e.g. `https://app.example.com`) this entry is scoped to. localStorage is
   *  per-origin, so the entry is only written when the page is on this origin. Defaults to
   *  the environment's `baseUrl` origin when omitted. */
  origin?: string;
}

/**
 * An environment as the API returns it (list + get). An environment is just a run target:
 * the base URL the test's `{{baseUrl}}` resolves to, plus cookies + localStorage seeded
 * before the run. No variables, no secrets — everything else lives on the test as literals.
 * The same shape the env management UI renders and the Run picker lists.
 */
export interface EnvironmentView {
  id: string;
  name: string;
  /** The base URL this environment runs against — substituted for `{{baseUrl}}` at replay. */
  baseUrl: string;
  /** Cookies seeded onto the browser context before each run against this environment. */
  cookies: EnvCookie[];
  /** localStorage entries seeded into the browser before each run against this environment. */
  localStorage: EnvLocalStorageItem[];
}

/** One checkpoint within a run, as the reviewer sees it. */
/**
 * How a capture was produced, as the agent that produced it described it.
 *
 * **Evidence, not a constraint.** Varys hosts no browser for an Agent-Driven Test (ADR 0007), so
 * every field is testimony it cannot verify and any of them may be absent. It is here because the
 * design knowingly allows a baseline shot headless at 1280x800 to be compared against an actual
 * taken through computer use on a Retina display — and when that comparison reads strangely, the
 * first thing a reviewer needs to know is whether the two images were even taken the same way.
 *
 * Null for every pinned checkpoint: Varys took those itself, under conditions the test records.
 */
export interface CaptureConditions {
  /** e.g. `chrome-devtools`, `playwright`, `computer-use`. */
  tool: string | null;
  /** e.g. `1440x900`. Free text — an unconstrained capture has no canonical spelling. */
  viewport: string | null;
  /** Device pixel ratio, e.g. `2` on a Retina display. */
  deviceScale: number | null;
}

/**
 * One extra screenshot an agent attached to a run: unnamed, keying no baseline, filling no
 * Manifest slot.
 *
 * "I could not find the filter, here is what the page looked like" is exactly what tells a
 * reviewer a broken app from a wrong instruction, and it is the only material about the parts of
 * the session Varys never saw. Browsable beside the checkpoints rather than filed elsewhere,
 * because the person who needs it is already looking at the failure.
 */
export interface RunEvidenceView {
  id: string;
  /** Authenticated artifact-route URL of the screenshot. */
  url: string;
  /** The agent's note about it, or empty when it attached none. */
  note: string;
  /** When it was attached, ISO 8601 — the order the session produced it in. */
  createdAt: string;
}

export interface CheckpointView {
  /** Checkpoint (screenshot) name within the test. */
  name: string;
  reviewState: ReviewState;
  /** How this checkpoint was captured (element / full-page / region). */
  captureMode: CaptureMode;
  /** How the capture was compared to its baseline — `pixel` (diff score) or `context`
   *  (LLM judge verdict + `judgeReasoning`). */
  compareMode: CompareMode;
  /** The recorded decision, or null while the checkpoint still needs review. */
  resolution: Resolution | null;
  /** Who recorded that decision (email) and when (ISO) — the audit pair for `resolution`.
   *  Both null while the checkpoint is unresolved (or for decisions made before this). */
  resolvedBy: string | null;
  resolvedAt: string | null;
  /** Pixel-diff score the server computed; null on a first seed (nothing to diff) or for a
   *  `context` checkpoint (which is judged, not pixel-scored). */
  diffScore: number | null;
  /** The LLM judge's one-line rationale for a `context` checkpoint; null for pixel checkpoints
   *  (and for a `context` first-seed with nothing to judge yet). */
  judgeReasoning: string | null;
  /** The per-checkpoint threshold the diff was judged against. */
  threshold: number;
  /** Whether the locator fell back to a lower-priority signal during the run. */
  healed: boolean;
  /** The checkpoint's current masks (from the latest test version) — the regions
   *  the diff ignores; what the in-viewer mask editor renders and edits. */
  masks: Rect[];
  /** Authenticated artifact-route URLs. baseline/diff are null on a first seed. */
  actualUrl: string | null;
  baselineUrl: string | null;
  diffUrl: string | null;
  /** Audit trail of the current approved baseline for this checkpoint+environment:
   *  who approved it and when (ISO). Null until a baseline has been approved (Slice 10). */
  baselineApprovedBy: string | null;
  baselineApprovedAt: string | null;
  /** How the actual was captured, when an agent said. Null for every pinned checkpoint, and for
   *  an agent one that was never filled or whose session volunteered nothing. */
  capture: CaptureConditions | null;
}

/**
 * One entry in the "needs review" list — a checkpoint currently awaiting a human
 * decision (`pending-baseline` or `diff`), with just enough context to triage and
 * open it. Not the slice-7 dashboard; a flat list, enough to find work.
 */
export interface NeedsReviewItem {
  runId: string;
  testName: string;
  environment: string;
  runTimestamp: string;
  checkpointName: string;
  /** Why it needs review: `pending-baseline` (first approval) or `diff`. Spelled out rather than
   *  `Exclude<ReviewState, "passed">`, because `missing` is also not-passed and is emphatically
   *  NOT awaiting a human decision — there is nothing to look at and nothing to approve. */
  reviewState: "pending-baseline" | "diff";
}

/**
 * One row in the Runs history — every run, newest first, regardless of outcome
 * (unlike NeedsReviewItem, which only lists checkpoints awaiting a decision). Enough
 * to scan run outcomes and open any one in the viewer.
 */
export interface RunSummary {
  runId: string;
  /** The test this run belongs to — lets the Runs list link straight to its Test Detail page. */
  testId: string;
  testName: string;
  /** Environment name the run executed against ("default" when none). */
  environment: string;
  /** Run-level status: queued | running | passed | needs_review | failed. */
  status: string;
  /** Derived display outcome refining `status` — `baseline` (this run set/updated goldens)
   *  vs `verified` (a real comparison pass), etc. Computed via {@link deriveRunOutcome}. */
  outcome: RunOutcome;
  runTimestamp: string;
  /** Why a `failed` run failed (the replay error); null otherwise. */
  error: string | null;
  /** Who triggered the run (email / "ai" sentinel), and how — `manual` | `suite` |
   *  `schedule` | `api`. Both null for runs created before attribution was recorded. */
  triggeredBy: string | null;
  triggerSource: string | null;
}

/** Aggregate child-run counts for a suite run — derived on read, never stored. */
export interface SuiteRunCounts {
  total: number;
  queued: number;
  running: number;
  passed: number;
  needsReview: number;
  failed: number;
  /** Children that read `healed` — they verified, but on a repair nobody has accepted yet
   *  (Slice 19, slice 06). They are a SUBSET of `passed`, not a sibling of it: a healed run does
   *  not fail the suite, so the aggregate still reports passing and this is the count that tells
   *  you how much of that pass is resting on unreviewed repairs. */
  healed: number;
}

/**
 * One row in the suite-runs history: a fan-out's parent (`suite × env(s)`,
 * DESIGN §6) with its derived aggregate. `suiteName` is a trigger-time snapshot,
 * so the report survives suite deletion/rename.
 */
export interface SuiteRunSummary {
  suiteRunId: string;
  suiteName: string;
  /** The suite this fan-out came from; `null` once that suite is deleted (the FK is SET NULL, so
   *  the history survives under the name snapshot). A re-run needs it — without it there is no
   *  membership to re-resolve, so the UI disables the button rather than guessing. */
  suiteId: string | null;
  /** Distinct environment names the fan-out targeted ("default" when none). */
  environments: string[];
  /** The surviving environment ids the fan-out targeted — what a re-run aims at. Empty for an
   *  env-less fan-out, and it omits any environment deleted since (see `environmentsMissing`). */
  environmentIds: string[];
  /** How many of the targeted environments no longer exist. A re-run against the survivors
   *  narrows the fan-out, so the UI says so instead of quietly running fewer children. */
  environmentsMissing: number;
  /** Distinct member tests in the fan-out — `total` is this × the environment count. */
  testCount: number;
  /** Derived from the children: all-queued → queued; any queued/running →
   *  running; else failed > needs_review > passed. */
  status: string;
  counts: SuiteRunCounts;
  runTimestamp: string;
  /** When the LAST child reached a terminal state; `null` while any child is still in flight. */
  finishedAt: string | null;
  /** Wall-clock from the trigger to that last child finishing; `null` while in flight. */
  durationMs: number | null;
  /** Who launched the fan-out — an email for a person's trigger, the `schedule` sentinel for a
   *  cron fire. Read off the children, which all carry the launcher's attribution. Null for
   *  fan-outs created before attribution was recorded. (There is no `triggerSource` here: every
   *  child of a fan-out is sourced `suite` by construction, so it would say nothing.) */
  triggeredBy: string | null;
}

/** One child inside a suite-run report — an ordinary run, opened via `?run=`. */
export interface SuiteRunChild {
  runId: string;
  /** The test this child replayed — what a per-child re-run targets. */
  testId: string;
  testName: string;
  /** Environment name this child ran against ("default" when none). */
  environment: string;
  /** The environment id, for a one-click per-child re-run; `null` when env-less. */
  environmentId: string | null;
  /** Whether that environment has since been deleted — a re-run then has to be re-chosen
   *  rather than silently falling back to env-less. */
  environmentMissing: boolean;
  status: string;
  /** Derived display outcome refining `status` (baseline vs verified, …), per
   *  {@link deriveRunOutcome}. The parent aggregate + counts stay on coarse `status`. */
  outcome: RunOutcome;
  error: string | null;
  /** Whether this child kept a Playwright trace — carried through by a re-run. */
  trace: boolean;
  runTimestamp: string;
  /** How long the child took; `null` while it is still queued or running. */
  durationMs: number | null;
  /** Checkpoints of this child still awaiting a human decision — the review debt one row of the
   *  report carries. */
  pendingCheckpoints: number;
}

/** The suite-run report: the aggregate plus children in stable test×env order. */
export interface SuiteRunView extends SuiteRunSummary {
  children: SuiteRunChild[];
}

/** One step of a run, as a label for the failed-run step sequence. */
export interface StepLabel {
  /** 0-based position in the run's steps. */
  index: number;
  /** Human label, e.g. `click "Submit"` or `navigate to "{{baseUrl}}/"`. */
  label: string;
}

/**
 * One EXECUTED step of a run, with timing and outcome — the per-step timeline
 * recorded for every run (traced or not). The skeleton the future custom timeline
 * UI renders; steps never reached are simply absent (derive "didn't run" from the
 * definition's full step list, as the failed-run view already does).
 */
export interface StepRun {
  /** 0-based position in the run's steps. */
  index: number;
  /** Human label (same vocabulary as StepLabel). */
  label: string;
  /** The checkpoint name when this step is a screenshot step; null otherwise.
   *  The join key to the matching CheckpointView. */
  checkpointName: string | null;
  /** When the step started executing, ISO 8601. */
  startedAt: string;
  /** How long the step took, milliseconds (to-failure for the failing step). */
  durationMs: number;
  /** `passed` (completed) | `failed` (the step that threw). */
  outcome: "passed" | "failed";
}

/**
 * One API request a run made — the record that tells a locator failure apart from a backend one.
 *
 * `failureKind` is derived from the thrown exception's TYPE, so "the button was renamed" and
 * "the button never rendered because /api/orders returned 500" both arrive as `locator`. These
 * are the facts that separate them, attributed to the step that was executing at the time.
 *
 * A bounded record, not a full network log: only `xhr` / `fetch` / `document` requests are
 * candidates, and a run keeps every problem plus its slowest few successes. Nothing here affects
 * how a run is classified, queued or repaired — it is evidence for a reader.
 */
export interface RunNetworkEvent {
  /** The step in flight when the request STARTED, or null when it started outside any step.
   *  Joins to `StepRun.index` / `StepLabel.index`. */
  stepIndex: number | null;
  method: string;
  url: string;
  /** Playwright's resource type: `xhr` | `fetch` | `document`. */
  resourceType: string;
  /** HTTP status, or null when no response ever arrived. */
  status: number | null;
  /** Chromium's transport error (`net::ERR_TIMED_OUT`), or the marker for a request the server
   *  never answered before the run ended — the API-timeout case. Null when it completed. */
  failureText: string | null;
  /** Wall-clock duration to completion, or to the end of the run for an unanswered request. */
  durationMs: number;
  /** Time to first byte; null when Chromium didn't supply it. Separate from `durationMs` so a
   *  slow SERVER is distinguishable from a large response. */
  ttfbMs: number | null;
  startedAt: string;
}

/**
 * ---- Assertions (Slice 19, slice 09) -----------------------------------------------------
 *
 * The vocabulary below MIRRORS `@varys/assertion-engine`, which owns it. It is restated as plain
 * string unions rather than imported for the same reason `RecordedTarget` is loose: this contract
 * is consumed by the SPA and must stay dependency-free. The server validates against the real
 * schema, so a divergence here surfaces as a type error the first time an API maps one to the
 * other, not as bad data.
 */

/** How a side's extracted text becomes a comparable value. */
export type Coercion = "text" | "number" | "sum-number" | "count" | "exists";

/** The comparison applied to the two coerced values. */
export type Relation =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "non-empty";

/**
 * An assertion's verdict on one run — and the distinction the whole slice exists to preserve:
 *
 *  - `passed`            — both values were read and the relation holds.
 *  - `relation-false`    — both values were read and they disagree. Evidence about the APP.
 *  - `extraction-failed` — a side produced no value, so nothing was compared. Evidence about the
 *                          TEST (a locator missed, or the text read was not a number).
 *
 * A surface that collapsed these two into one "failed" would be telling the reader that the
 * application is wrong when what actually happened is that Varys could not look.
 */
export type AssertionOutcome =
  | "passed"
  | "relation-false"
  | "extraction-failed"
  /** The fallback judge read the page and answered no (slice 11) — approximate evidence about the
   *  app. It fails the run, like any other failing assertion, and is never repairable. */
  | "judge-failed"
  /** The fallback judge could not be reached at all, so NOTHING was checked. Neither a pass nor a
   *  failure: the run goes needs-review, because a model outage must not read as a green. */
  | "judge-unavailable";

/**
 * How an assertion was evaluated — exact (`pinned`) or approximate (`judged`).
 *
 * The author-facing half of slice 11. An approximate check wearing an exact one's clothes is how
 * someone discovers months later that "the totals are right" was never really being verified, so
 * every surface that shows a verdict shows which machinery produced it.
 */
export type AssertionMode = "pinned" | "judged";

/** Why extraction failed: `unresolved` (a locator problem) | `coercion` (a definition problem). */
export type ExtractionCause = "unresolved" | "coercion";

/** One side of a pinned comparison, as a reader sees it: an element to read, or a typed literal. */
export interface AssertionSideView {
  /** What the side reads, distilled for display — null when this side is a literal. */
  target: FingerprintSummary | null;
  /** How the read text is coerced — null when this side is a literal. */
  as: Coercion | null;
  /** The author-typed fixed value — null when this side reads the page. */
  literal: string | number | null;
}

/**
 * The pinned form, for display: which elements it reads, how each is coerced, and what is
 * compared. Shown on the test editor (so an author can see what a check actually does) and on run
 * detail beside the verdict. Null on an assertion that is declared but not yet pinned — which is
 * documentation, and is never evaluated.
 */
export interface PinnedAssertionView {
  left: AssertionSideView;
  right: AssertionSideView;
  relation: Relation;
  /** Numeric slack, for numeric relations only; null when exact. */
  tolerance: number | null;
}

/** One past verdict for an assertion — the per-assertion history strip on run detail. */
export interface AssertionHistoryPoint {
  runId: string;
  runTimestamp: string;
  outcome: AssertionOutcome;
}

/**
 * One assertion's result on a run, with its own history.
 *
 * `id` is the author-chosen, stable id from the definition: it survives an edit to `check`, which
 * is exactly what lets `history` span the wording change instead of starting a new line.
 */
export interface AssertionResultView {
  id: string;
  /** The plain-language check AS IT READ on this run (the definition's may have moved on). */
  check: string;
  outcome: AssertionOutcome;
  /** Exact or approximate — which machinery reached this verdict (slice 11). */
  mode: AssertionMode;
  /** Set only when `outcome` is `extraction-failed`. */
  cause: ExtractionCause | null;
  /** The two coerced values compared, rendered; null for a side that produced none. */
  left: string | null;
  right: string | null;
  /** The engine's one-line explanation — what was compared and what happened. */
  detail: string;
  /** The judge's own rationale, shown beside the check text. Null for a pinned verdict — its
   *  `detail` IS its reasoning, and there is no second, softer account of it to give. */
  reasoning: string | null;
  /** The pinned form the run evaluated, for display; null if the definition no longer pins it. */
  pinned: PinnedAssertionView | null;
  /** This assertion's verdicts on earlier runs of the same test, oldest first, INCLUDING this
   *  run — its own history over time. */
  history: AssertionHistoryPoint[];
}

/** One declared assertion as the test editor shows it. */
export interface TestConfigAssertion {
  /** Stable and author-chosen — editing `check` never changes it. */
  id: string;
  check: string;
  /**
   * How every run will evaluate this assertion (slice 11): `pinned` ⇒ exactly, in the worker, with
   * no model call; `judged` ⇒ approximately, by the vision judge reading the page.
   *
   * Derivable from `pinned` being null, and sent anyway — the editor's badge is the one place an
   * author learns which of their checks are exact, and a surface that has to infer that from a
   * null is a surface that will one day infer it wrong.
   */
  mode: AssertionMode;
  /** The pinned form, or null when the assertion is judged rather than pinned. */
  pinned: PinnedAssertionView | null;
  /**
   * Why this check could not be pinned, written by whoever tried (slice 12's Authoring Session).
   * Null when it is pinned, and null when nobody has examined it.
   *
   * The distinction that earns it a field: "nobody has pinned this yet" and "this was examined and
   * genuinely cannot be pinned" are the same absent `pinned`, and they ask opposite things of an
   * author. With a reason, the Approximate badge explains itself; without one it is a shrug.
   */
  unpinnableReason: string | null;
  /**
   * What the pinned vocabulary CAN express, so an author looking at an approximate check knows how
   * to rephrase it into an exact one. Null for an assertion that is already pinned — there is
   * nothing to rephrase.
   */
  pinningHelp: string | null;
}

/**
 * A distilled, display-oriented view of the recorded element fingerprint the worker
 * resolves a step against. Surfaced behind the run viewer's on-demand "what the locator
 * was looking for" panel — shown for every step/checkpoint that has a target, so both a
 * clean match and a failed locate are explainable without re-running a trace. A subset
 * of the full step-schema fingerprint — only the human-meaningful signals.
 */
export interface FingerprintSummary {
  /** The element's tag, e.g. `div`, `button`. */
  tag: string;
  /** ARIA role, explicit or implicit; null when none. */
  role: string | null;
  /** The accessible name the matcher recorded; null when the element had none. */
  accessibleName: string | null;
  /** Whether the accessible name came from a stable attribute (aria-label/title) rather
   *  than volatile visible text — a durable-name signal. */
  nameFromAttr: boolean;
  /** Visible text snapshot — may be long or carry volatile data (dates, live numbers);
   *  truncated for display. */
  text: string | null;
  /** `data-testid`, if recorded — the strongest, most durable signal. */
  testId: string | null;
  /** The element's `id` attribute, if any. */
  elementId: string | null;
  /** Other identifying attributes (id excluded — surfaced separately); null when none. */
  attributes: Record<string, string> | null;
  /** Durable (non-build-hashed) classes the matcher prefers; null when none. */
  stableClasses: string[] | null;
  /** All raw classes — includes build-hashed ones that rotate per deploy; null when none. */
  moduleClasses: string[] | null;
  /** Ancestor chain, nearest first, as compact `tag[role]#id` labels; null when none. */
  ancestors: string[] | null;
  /** Recorded position + size in screenshot pixels; null when not captured. */
  boundingBox: Rect | null;
  /** An author-supplied raw selector override (Slice 16.2); null when none. Used as-is by
   *  the matcher when it resolves to exactly one element, else the signals above take over. */
  selectorOverride: string | null;
}

/** A run and its checkpoints, with the identifying context the reviewer needs. */
export interface RunView {
  runId: string;
  /** Run-level status taxonomy (queued | running | passed | needs_review | failed). */
  status: string;
  /** Derived display outcome refining `status` — distinguishes a baseline-creation/-update
   *  run (`baseline`) from a real verification pass (`verified`), since both store
   *  `status="passed"`. Computed server-side via {@link deriveRunOutcome}; the client only
   *  displays it (never recomputes). */
  outcome: RunOutcome;
  /** The test this run belongs to — lets Run Detail link straight to its Test Detail page. */
  testId: string;
  /** The fan-out this run is a child of, or `null` for a standalone run. Run Detail uses it to
   *  send you back where you came from: a child opened from a suite-run report returns to that
   *  report, not to the flat runs history it is deliberately excluded from. */
  suiteRunId: string | null;
  /** Test name, for display without a separate lookup. */
  testName: string;
  /** Environment name the run executed against ("default" when none was chosen). */
  environment: string;
  /** The environment id a re-run should target — null when the run was env-less, and also null
   *  when the environment it used has since been DELETED, so a re-run can never point at a dead
   *  id. `environmentMissing` distinguishes those two cases. */
  environmentId: string | null;
  /** True when this run recorded an environment that no longer exists. A re-run then has to ask
   *  which environment to use instead of silently falling back to env-less. */
  environmentMissing: boolean;
  /** Whether the trigger asked for a Playwright trace, so a re-run can repeat the same request.
   *  Distinct from `traceUrl`, which is null until the trace is actually captured. */
  trace: boolean;
  /** When the run was created, ISO 8601. */
  runTimestamp: string;
  /** Who triggered the run (email / "ai" sentinel), and how — `manual` | `suite` |
   *  `schedule` | `api`. Both null for runs created before attribution was recorded. */
  triggeredBy: string | null;
  triggerSource: string | null;
  /** Why a `failed` run failed (the replay error); null otherwise. A failed run
   *  captures no checkpoints, so this is what the viewer shows instead. */
  error: string | null;
  /** For a `failed` run: the run's full step sequence (labels) so the viewer can show
   *  which step failed and which never ran. Empty for non-failed runs. */
  steps: StepLabel[];
  /** For a `failed` run: 0-based index into `steps` of the step that failed, or null
   *  when it failed before any step ran (e.g. environment resolution). */
  failedStepIndex: number | null;
  /** The recorded target fingerprint per step, indexed by step position (0-based) — what
   *  the locator was looking for. `null` for steps with no element target (navigate, or a
   *  full-page / region screenshot). Powers the viewer's on-demand "what the locator was
   *  looking for" panel for EVERY step/checkpoint, passed or failed. */
  fingerprints: (FingerprintSummary | null)[];
  /** Artifact URL of the kept Playwright trace zip, or null when the trigger
   *  didn't request one (traces are per-trigger on demand only). */
  traceUrl: string | null;
  /** The per-step execution timeline (every run): one entry per step that ran,
   *  in order. Empty until the run starts executing. */
  timeline: StepRun[];
  /** The API traffic this run saw (every run): every failed / errored / unanswered request plus
   *  the slowest successes, in start order. Read it beside a `locator` failure before believing
   *  the label — a step whose window contains a 500 or an unanswered request failed because the
   *  element was never rendered, not because its locator went stale. Empty for a run that made
   *  no notable requests, and for every run that predates the capture. */
  network: RunNetworkEvent[];
  checkpoints: CheckpointView[];
  /** Optional free-form note on the run, or null when none. Editable from the run-detail page. */
  notes: string | null;
  /** Which CLASS of failure ended this run, when it is classified (Slice 19). `locator` is the
   *  only repairable class — the run-detail "repair this" affordance is offered on that and
   *  nothing else; every other class gets a read-only Triage Job (slice 08). */
  failureKind: RunFailureKind;
  /** The triage finding written onto this run (Slice 19, slice 08): a drainer's written
   *  explanation of a failure it was NOT allowed to fix — "the chart is empty because
   *  /api/metrics returns 401". Null until one is reported.
   *
   *  A diagnosis, never a resolution: the run's `outcome` is completely unaffected by it, which is
   *  the whole point of the slice. Shown beside the failure so a red cell becomes actionable. */
  triageFinding: string | null;
  /** Who wrote the finding (a `Repair Agent "…"` label) and when, ISO. Null with the finding. */
  triageBy: string | null;
  triageAt: string | null;
  /** The Repair Policy of the run's test, so run detail can say whether a repair would have
   *  been enqueued automatically or needs enqueuing by hand. */
  repairPolicy: RepairPolicy;
  /**
   * Every pinned assertion this run evaluated, each with its own verdict and its own history
   * (slice 09). Empty for a test that declares none, and for every run that predates them.
   *
   * Separate from `checkpoints` on purpose: an assertion is not a picture, and a reviewer has no
   * baseline to approve. A failing one has already made the run `failed` — there is no decision to
   * take here, only something to read.
   */
  assertions: AssertionResultView[];
  /**
   * Which kind of test this run belongs to, and therefore which run view is the right one.
   *
   * An `agent` run has no steps, no timeline and no pixel diff: it is a Checkpoint Manifest walked
   * by the author's own local Claude, reported one slot at a time. The two are one corpus and sit
   * side by side in the runs list and the dashboard — but reading one as the other would show a
   * step-by-step replay of a session Varys never observed.
   */
  kind: TestKind;
  /** The agent's own written account of the session, or null (a pinned run, or one whose session
   *  never called `finish_agent_run`). The only record of the part Varys could not watch. */
  agentSummary: string | null;
  /**
   * The fully composed AI Instructions this run was started with, copied onto it verbatim.
   *
   * The compensating control for unversioned instructions: suite, test and checkpoint text are all
   * editable without writing a `test_version`, so without this copy a run from six weeks ago is
   * unexplainable. Null for a pinned run.
   */
  agentInstructions: string | null;
  /** Extra screenshots the agent attached during the session, oldest first. Empty for a pinned
   *  run and for an agent run that attached none. */
  evidence: RunEvidenceView[];
  /**
   * The one finding behind every unfilled Manifest slot, or null when nothing went unreached.
   * Derived via {@link deriveUnreachedRootCause} so the view states a cause once instead of
   * presenting each consequence as its own failure.
   */
  unreached: UnreachedRootCause | null;
  /**
   * The Agent Run Session's wall-clock lease and where it stands against it — null for a pinned
   * run, and for an agent run started before leases existed.
   *
   * What it buys the view is the distinction it could not otherwise draw: an agent that finished
   * and reported, an agent whose time ran out, and an agent that may still be walking are three
   * different things, and before the lease the last two were indistinguishable.
   */
  session: AgentSessionView | null;
}

/**
 * The derived, display-facing run outcome — a strict refinement of the stored `status`. Varys
 * follows the **test-runner model**, with one nuance: a *first* run has no baseline to compare to,
 * so it isn't a failure — it's **`pending-baseline`** (awaiting your approval to seed the golden).
 * Once a baseline exists, a capture that *differs* (or a crash) is **`failed`** (red) and the only
 * action is to set the new actual as the baseline; a real bug is left red and fixed in the app. A
 * run that set/updated the baseline reads **`baseline`**; a clean match reads **`passed`**. Computed
 * server-side and sent as {@link RunView.outcome} / `RunSummary.outcome`; the client only displays it.
 */
export type RunOutcome =
  | "queued"
  | "running"
  | "cancelled" // stopped before finishing (e.g. its test was deleted mid-run)
  | "passed" // had a baseline and the capture matched — a real verification pass
  | "baseline" // this run set or updated the golden baseline (first approval or "set as baseline")
  | "pending-baseline" // first run — no baseline yet, awaiting approval (NOT a failure)
  | "healed" // it verified, but only because an UNACCEPTED repair is in the definition it replayed
  | "regression" // a baseline existed but the capture differs — a visual difference (incl. a rejected diff)
  | "failed"; // the replay crashed or an element couldn't be located — an execution failure

/** The minimal per-checkpoint shape {@link deriveRunOutcome} reads — `CheckpointView` satisfies it. */
export interface RunOutcomeCheckpoint {
  reviewState: ReviewState;
  resolution: Resolution | null;
}

/** The minimal per-run shape {@link deriveRunOutcome} reads. */
export interface RunOutcomeRun {
  status: string;
  error?: string | null;
  /** True when the DEFINITION this run replayed contains a repair no human has accepted yet —
   *  i.e. the run's test version was written by a Repair Agent and is still `unreviewed`
   *  (Slice 19, slice 06). It is the one input that is NOT derivable from the checkpoints: a
   *  clean re-run after a repair looks identical to any other clean run, and the difference —
   *  that its greenness rests on an unreviewed edit — is a property of the version, not of a
   *  pixel comparison. Derive it with {@link isRepairInReview}. */
  repairApplied?: boolean;
}

/**
 * Does this test version carry a repair that is still waiting on a human? The single definition
 * of {@link RunOutcomeRun.repairApplied}, so every surface asks it the same way.
 *
 * `unreviewed` is the only state that counts. An `accepted` repair has been signed off, so runs
 * against it are ordinary passes again — `healed` is a review-queue marker, not a permanent scar
 * on the test's history. A `rejected` one never stood at all.
 */
export function isRepairInReview(
  /** `test_versions.repair_job_id` of the version the run replayed. */
  repairJobId: string | null,
  /** `test_versions.review_state` of that same version. */
  reviewState: string | null,
): boolean {
  return repairJobId != null && reviewState === "unreviewed";
}

/**
 * Roll a run's checkpoints up into the coarse `runs.status` column — the STORED status, as
 * distinct from {@link deriveRunOutcome}, which refines how that run is displayed.
 *
 * Pure, and shared on purpose. Two very different writers depend on this answer: a human
 * approving or rejecting a checkpoint, and an agent filling a Checkpoint Manifest slot. They
 * arrive from opposite directions — one is resolving a finished run downwards, the other is
 * building an unfinished one upwards — and if their rollups ever disagreed, a run's stored status
 * would depend on which of them touched it last.
 *
 * Precedence, top → down:
 *  1. any `missing` slot  → `failed`
 *  2. anything undecided  → `needs_review`
 *  3. any rejection       → `failed`
 *  4. otherwise           → `passed`
 *
 * `missing` is checked first and hard-fails. An unfilled slot is neither work awaiting a human nor
 * something a decision on a SIBLING checkpoint can resolve, so resolving the last reviewable
 * checkpoint on such a run must not roll it up to passed — which is the one path by which an
 * agent that simply stopped could have ended up green.
 *
 * A rejection sits BELOW an undecided checkpoint, which reads backwards until you remember what
 * this column drives: a run with review work outstanding belongs in the review queue, and a
 * rejection already taken is not a reason to hide the decisions still owed. The run reads red
 * either way — {@link deriveRunOutcome} calls a rejection `regression` regardless of what is
 * stored here.
 */
export function rollupRunStatus(
  checkpoints: readonly RunOutcomeCheckpoint[],
): "passed" | "needs_review" | "failed" {
  let anyMissing = false;
  let anyPending = false;
  let anyRejected = false;
  for (const c of checkpoints) {
    if (c.reviewState === "missing") anyMissing = true; // an unfilled slot — nothing resolves it
    else if (c.resolution === "rejected") anyRejected = true;
    else if (c.resolution === "approved") continue; // resolved → promoted to baseline
    else if (c.reviewState === "pending-baseline" || c.reviewState === "diff") anyPending = true;
  }
  return anyMissing ? "failed" : anyPending ? "needs_review" : anyRejected ? "failed" : "passed";
}

/** One Checkpoint of the journey, as the composed instructions spell it out. */
export interface AgentInstructionSlot {
  /** Position in the journey, 1-based — the number a person counts the walk in. */
  step: number;
  /** The Manifest name, which is also the only name the slot may be reported under. */
  name: string;
  /** How to reach this state, carrying on from the previous slot. */
  instructions: string;
  /** What must be true in the capture for it to match its baseline. Already resolved against the
   *  global default judge prompt by the caller — this layer does no falling back of its own. */
  comparePrompt: string;
}

/** The three layers of AI Instructions, outermost first, plus what the run is being pointed at. */
export interface AgentInstructionLayers {
  testName: string;
  /** The environment name the run is against — `default` when the run has no environment. */
  environment: string;
  /** The environment's base URL, or `""` when it has none. */
  baseUrl: string;
  /**
   * The outermost layer: standing context from every suite that carries AI Instructions and
   * selects this test. A list rather than one string because a test can belong to several suites,
   * and silently picking one of them would be the worst of the three available answers.
   *
   * Order is the caller's and is preserved, so the composed text is stable between runs.
   */
  suites: readonly { name: string; instructions: string }[];
  /** The middle layer: the test's own AI Instructions (`tests.intent`). */
  testInstructions: string;
  /** The innermost layer: each Checkpoint's own instructions and comparison prompt. */
  slots: readonly AgentInstructionSlot[];
}

/**
 * The document handed to the agent at the start of an Agent Run Session, and copied verbatim onto
 * the run.
 *
 * Layers are **concatenated, general → specific** — suite, then test, then the checkpoint's own —
 * and **never overridden**. These are additive context ("here is the app" / "here is this journey"
 * / "here is this state"), not competing settings; override semantics would need per-key structure
 * that prose does not have, and a layer that can be silently discarded is a layer whose author
 * cannot tell whether it took effect.
 *
 * Pure, and shared, for the same reason `describeLease` is: this exact text is what `start_agent_run`
 * returns to the agent, what is stored on the run, and what the author previews BEFORE running. A
 * preview assembled by a second code path would be a preview of something else, and the whole point
 * of the preview is that three layers assembled out of sight produce a baffling run an hour later.
 *
 * Written as a readable document rather than a JSON blob because a human reads it too — it is what
 * the run detail shows when someone asks what the agent was actually told.
 */
export function composeAgentInstructions(input: AgentInstructionLayers): string {
  const lines: string[] = [];
  lines.push(`# ${input.testName}`);
  lines.push("");
  lines.push(`Environment: ${input.environment}${input.baseUrl ? ` (${input.baseUrl})` : ""}`);
  lines.push("");

  // Blank layers are dropped rather than headed, in both directions: a suite that carries no
  // instructions must leave no trace at all, or the author of the NEXT layer reads a named,
  // empty section and wonders what was supposed to be in it.
  const suiteLayers = input.suites
    .map((s) => ({ name: s.name, instructions: s.instructions.trim() }))
    .filter((s) => s.instructions !== "");
  if (suiteLayers.length > 0) {
    lines.push("## Shared context");
    lines.push("");
    // Says what this layer IS, because the agent reads all three as one document and the failure
    // mode is treating the outermost as the authoritative one. It is environmental — which app,
    // which account, what to ignore — and everything below adds to it.
    lines.push(
      suiteLayers.length === 1
        ? `Standing context from the suite this test belongs to. It describes the surroundings — which app, which account, what to ignore — and nothing below replaces it; the sections that follow are more specific and add to it.`
        : `Standing context from the ${suiteLayers.length} suites this test belongs to. It describes the surroundings — which app, which account, what to ignore — and nothing below replaces it; the sections that follow are more specific and add to it. Where two suites say different things, both are shown, because neither outranks the other.`,
    );
    lines.push("");
    for (const suite of suiteLayers) {
      lines.push(`### Suite: ${suite.name}`);
      lines.push("");
      lines.push(suite.instructions);
      lines.push("");
    }
  }

  const testLayer = input.testInstructions.trim();
  if (testLayer) {
    lines.push("## AI Instructions");
    lines.push("");
    lines.push(testLayer);
    lines.push("");
  }

  lines.push("## Checkpoints");
  lines.push("");
  lines.push(
    "Walk these in order. Each one carries on from the last, so the page is wherever the previous checkpoint left it.",
  );
  lines.push("");
  for (const slot of input.slots) {
    lines.push(`### ${slot.step}. ${slot.name}`);
    lines.push("");
    lines.push("How to get here:");
    lines.push(slot.instructions.trim() || "(not specified)");
    lines.push("");
    lines.push("What counts as matching its baseline:");
    lines.push(slot.comparePrompt.trim() || "(not specified)");
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * The fully composed AI Instructions, as an author reads them BEFORE starting a run.
 *
 * Returned by its own read-only endpoint rather than by starting a session, because the point is
 * to see what the agent will be told without spending a Claude subscription to find out.
 */
export interface AgentInstructionsPreview {
  /** The exact document `start_agent_run` would hand the agent right now. */
  instructions: string;
  /** The names of the suites that CONTRIBUTED a layer, so "why is that in there?" is answerable
   *  from the preview itself. Empty when no suite contributed. */
  suites: string[];
  /** The environment the preview was composed against — `default` when none was given. */
  environment: string;
  /** How many Checkpoints the document walks. Zero is legal here and refused at run start. */
  checkpointCount: number;
}

/**
 * The longest lease a test may be given — twenty-four hours.
 *
 * A ceiling and no floor (beyond "a positive number of seconds"), which is not an oversight. Too
 * LONG is the failure the lease exists to prevent, and it is silent: nobody notices the quota
 * draining. Too SHORT fails loudly and immediately — the run goes red saying it hit its bound — so
 * it corrects itself the first time it happens, and Varys has no basis for deciding how long
 * someone else's journey ought to take.
 *
 * The DEFAULT is deliberately not here: it lives in exactly one place, the `tests.agent_lease_seconds`
 * column default, so a test's lease is always a value read off the row rather than a constant two
 * packages might disagree about.
 */
export const AGENT_LEASE_MAX_SECONDS = 86_400;

/**
 * A lease in the units a person would say it in — "15 minutes", "1 hour", "90 seconds".
 *
 * Shared, and for a reason a formatter does not usually earn: the same number is said to the AGENT
 * (in the tool response that grants the lease, and in the refusal when it runs out) and to the
 * PERSON (in the run view that reports it), and those two must not disagree about how long the run
 * was allowed to take.
 *
 * Exact rather than approximate — it steps down to the finer unit instead of rounding. A 90-second
 * lease rendered as "2 minutes" would overstate a bound by a third, and a bound is the one number
 * here that has to be literally true.
 */
export function describeLease(seconds: number): string {
  const unit = (n: number, name: string): string => `${n} ${name}${n === 1 ? "" : "s"}`;
  if (seconds >= 3600 && seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  if (seconds >= 60 && seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

/**
 * What an Agent Run Session is doing now, as far as Varys can tell.
 *
 * - `open` — inside its lease, and Varys has no idea whether an agent is still walking it. This is
 *   the honestly ambiguous state; every run had it before leases existed.
 * - `expired` — the wall clock passed the lease. The session is closed: nothing more may be
 *   submitted to it, and whatever it left unfilled is what this run verified.
 * - `finished` — the agent closed it itself with a written summary.
 *
 * `expired` and `finished` are the pair the run view must never blur. Both end the session, but one
 * is an agent that reached the end of the journey and said so, and the other is an agent that ran
 * out of time — a finding about the app or about the instructions, not about the agent.
 */
export type AgentSessionState = "open" | "expired" | "finished";

/** The Agent Run Session behind a run — its bound, and where it stands against it. */
export interface AgentSessionView {
  /** The wall-clock lease it was granted at start, in seconds. Copied onto the run, so editing
   *  the test's lease afterwards does not rewrite what this session was actually given. */
  leaseSeconds: number;
  /** When that lease runs out (ISO). Computed once at start: the deadline is absolute, so it does
   *  not move if the run row is touched later. */
  leaseExpiresAt: string;
  /** Which of the three states it is in, as of the moment the read-model was built. */
  state: AgentSessionState;
}

/**
 * Which of the three states an Agent Run Session is in. Pure (no IO, no ambient clock — `now` is
 * passed), and shared because both callers ACT on it: the API refuses a submission on an expired
 * session, and the run view says the session hit its bound. Deciding it twice would let a run read
 * as still running while its own tools tell the agent it is over.
 *
 * A summary outranks the clock. A session that finished stays finished however long afterwards the
 * run is read — otherwise every completed agent run would quietly become an expired one an hour
 * later, which is the most misleading thing this could possibly do.
 */
export function deriveAgentSessionState(
  session: {
    /** Whether `finish_agent_run` wrote its account of the session (`runs.agent_summary`). */
    summaryWritten: boolean;
    /** The deadline, or null for a run started before leases existed — which is left `open`
     *  rather than having a deadline invented for it retrospectively. */
    leaseExpiresAt: string | Date | null;
  },
  now: number | Date,
): AgentSessionState {
  if (session.summaryWritten) return "finished";
  if (session.leaseExpiresAt == null) return "open";
  const deadline =
    session.leaseExpiresAt instanceof Date
      ? session.leaseExpiresAt.getTime()
      : Date.parse(session.leaseExpiresAt);
  if (!Number.isFinite(deadline)) return "open";
  // `>=`, because a lease "until 10:00" is over AT 10:00 — the boundary instant belongs to the
  // bound, not to the last moment of the session.
  return (now instanceof Date ? now.getTime() : now) >= deadline ? "expired" : "open";
}

/** The minimal per-slot shape {@link deriveUnreachedRootCause} reads — `CheckpointView` satisfies it. */
export interface UnreachedCheckpoint {
  /** The Checkpoint Manifest slot name. */
  name: string;
  reviewState: ReviewState;
}

/**
 * Where an agent-driven run's journey actually stopped — one fact, not one per unfilled slot.
 *
 * Null when nothing went unreached. Otherwise the FIRST unfilled slot in Manifest order, which is
 * the only one that carries information: the Manifest is cumulative, so every later slot was
 * unreachable the moment this one was, and reporting them as peers turns "login broke" into four
 * independent mysteries.
 */
export interface UnreachedRootCause {
  /** The slot the journey stopped at — the first one, in order, that was never filled. */
  checkpointName: string;
  /** Its 1-based position in the Manifest, so the view can say "stopped at step 3 of 5". */
  step: number;
  /** The last slot actually filled before it, or null when the run never reached anything at all
   *  (login broke on the first screen — there is no "it got this far"). */
  lastReached: string | null;
  /**
   * The unfilled slots IMMEDIATELY after it, in order — and only those.
   *
   * Contiguity is the whole claim. A Manifest is cumulative, so the slots directly behind a break
   * were unreachable because of it; but once the session fills something again it has demonstrably
   * got past it, and a slot missed later is a second thing going wrong, not fallout from the
   * first. Sweeping those in here would be the exact failure this type exists to prevent, with
   * the sign flipped: instead of five failures where there is one, one failure where there are two.
   */
  alsoUnreached: string[];
  /**
   * True when the session filled a slot after this break — it carried on rather than stopping.
   *
   * The honesty flag on the summary: one root cause is a way of not repeating yourself, never a
   * licence to hide the second thing that went wrong. When this is true, "the journey stopped at
   * X" is not the whole story and the view must not say it is.
   */
  resumed: boolean;
}

/**
 * Reduce a run's unfilled Manifest slots to the one finding behind them. Pure (no IO), shared so
 * the run view and anything else that summarises a red agent run cannot disagree about which slot
 * is the cause and which are the fallout.
 *
 * `checkpoints` must be in **Manifest order** — the order the agent was asked to walk. That is why
 * `run_results` rows are stamped in journey order when they are seeded: the sequence is a property
 * of the run, and re-deriving it later from the test would let an edit reorder history.
 */
export function deriveUnreachedRootCause(
  checkpoints: readonly UnreachedCheckpoint[],
): UnreachedRootCause | null {
  const firstIndex = checkpoints.findIndex((c) => c.reviewState === "missing");
  if (firstIndex === -1) return null;

  const before = checkpoints.slice(0, firstIndex);
  const after = checkpoints.slice(firstIndex + 1);
  // Stop at the first slot that WAS filled: everything up to it is blocked by this break, and
  // everything past it belongs to a session that had already recovered.
  const blockedEnd = after.findIndex((c) => c.reviewState !== "missing");
  const blocked = blockedEnd === -1 ? after : after.slice(0, blockedEnd);
  return {
    checkpointName: checkpoints[firstIndex].name,
    step: firstIndex + 1,
    // The last one BEFORE the break that was actually filled. Not simply `before.at(-1)`: an
    // earlier slot could itself be unfilled only if it were the first, which it is not by
    // construction — but reading it explicitly keeps the field true if that ever changes.
    lastReached: [...before].reverse().find((c) => c.reviewState !== "missing")?.name ?? null,
    alsoUnreached: blocked.map((c) => c.name),
    resumed: blockedEnd !== -1,
  };
}

/**
 * Map a run's checkpoints + coarse `status` into a {@link RunOutcome}. Pure (no IO) — the single
 * definition every surface shares (run detail, runs list, dashboard matrix, suite report) so they
 * can't drift. `status` and the stored status column are unchanged; this only refines display.
 *
 * Precedence, top → down:
 *  1. queued / running                  → unchanged
 *  2. execution error                   → `failed`  (a crash)
 *  3. any `missing` checkpoint          → `failed`  (a Manifest slot was never filled)
 *  4. any unaccepted `diff` (or legacy `rejected`) → `regression`  (a baseline existed and changed)
 *  5. any unresolved first-capture seed → `pending-baseline`  (no baseline yet — awaiting approval)
 *  6. nothing was actually verified     → `failed`  (it captured nothing to compare)
 *  7. an unaccepted repair is in play   → `healed`  (it verified, but on an unreviewed repair)
 *  8. any checkpoint set as baseline    → `baseline`
 *  9. otherwise (all matched)           → `passed`
 *
 * `missing` outranks EVERYTHING below queued/running and a crash, and both directions matter. Above
 * `regression`, because an unreached checkpoint means the journey broke, and that is more urgent and
 * more actionable than a pixel that moved earlier in the flow. Above `pending-baseline`, or a first
 * run that reached nothing would read as "awaiting approval" — the most flattering possible
 * description of having checked nothing. Above `healed` and `baseline` for the same reason the
 * execution-failure rule sits above `healed`: neither a repair nor a baseline write may dress an
 * unfilled slot up as anything other than red.
 *
 * A diff outranks a pending seed: a real failure against an established baseline is more urgent than
 * approving a brand-new checkpoint. A `resolution="approved"` checkpoint was promoted to the
 * baseline (seed approval, accepted diff, or a re-baselined pass) — a baseline write.
 *
 * `healed` sits BELOW `regression` and `failed` and ABOVE `baseline`/`passed`, and both halves of
 * that matter. Below, because a re-pinned locator must never soften a real visual break: if the
 * pixels also moved, `regression` stays the headline and the repair is beside the point. Above,
 * because a repair nobody has accepted is the most interesting thing about an otherwise-green run
 * — collapsing it into `passed` is exactly the silent pass the whole slice exists to prevent.
 * Operationally `healed` is a queue item, not an alarm: same weight class as `pending-baseline`.
 */
export function deriveRunOutcome(
  checkpoints: readonly RunOutcomeCheckpoint[],
  run: RunOutcomeRun,
): RunOutcome {
  if (run.status === "queued" || run.status === "running") return run.status;
  if (run.status === "cancelled") return "cancelled";
  if (run.error != null && run.error !== "") return "failed";

  let unfilled = false;
  let failing = false;
  let pendingSeed = false;
  let baselineWrite = false;
  let matched = false;

  for (const c of checkpoints) {
    // Checked before `resolution`, because an unfilled slot can carry neither: there is no capture
    // to approve or reject, so a resolution on one could only be data corruption — and treating it
    // as a baseline write is the one reading that would turn it green.
    if (c.reviewState === "missing") unfilled = true; // expected, never filled
    else if (c.resolution === "approved") baselineWrite = true; // promoted to baseline
    else if (c.resolution === "rejected") failing = true; // legacy: a confirmed bug stays red
    else if (c.reviewState === "diff") failing = true; // an established baseline changed
    else if (c.reviewState === "pending-baseline") pendingSeed = true; // first capture, no baseline yet
    else if (c.reviewState === "passed") matched = true;
  }

  if (unfilled) return "failed"; // a Manifest slot was never filled — nothing may soften this
  if (failing) return "regression"; // a visual difference (changed baseline or rejected diff) outranks the rest
  if (pendingSeed) return "pending-baseline"; // first run awaiting approval (not a failure)
  // No checkpoints (or all neutral) — mirror the stored status. A non-passing run here is
  // an execution failure (it captured nothing to compare), so `failed`, not `regression`. Checked
  // BEFORE `healed`, so a repair can never dress an execution failure up as an amber queue item.
  if (!matched && !baselineWrite && run.status !== "passed") return "failed";
  if (run.repairApplied) return "healed"; // green, but resting on a repair nobody has accepted
  if (baselineWrite) return "baseline"; // a golden was set/updated, nothing failing
  return "passed";
}

/**
 * The KPI summary strip on the run dashboard — headline figures, each with a delta
 * against the prior comparable window. Everything is computed server-side (derived
 * on read from runs/run_results/tests); the web layer only formats and labels it,
 * never recomputes. (Slice 7 — Run dashboard.)
 */
export interface DashboardSummary {
  /** Total saved tests (recordings). */
  totalTests: number;
  /** Distinct environments that have at least one run ("across N environments"). */
  environmentsCount: number;
  /** Tests created in the last 7 days (the total-tests delta). */
  totalTestsDelta: number;
  /** Verification pass rate over the last 7 days: `passed` ÷ verifications, where a verification
   *  is a run whose derived outcome is `passed` or `failed`. Baseline-establishment and first-run
   *  (`pending-baseline`) runs are EXCLUDED — they verify nothing. `0` when no verification finished
   *  in the window. */
  passRate: number;
  /** Signed percentage-point change in pass rate vs the prior 7-day window. */
  passRateDeltaPct: number;
  /** Checkpoints currently awaiting a decision (`pending-baseline`|`diff`, unresolved). */
  needsReview: number;
  /** Of those pending checkpoints, how many arrived in the last 7 days. */
  needsReviewDelta: number;
  /** Runs that failed in the last 24 hours. */
  failures24h: number;
  /** Signed change vs the prior 24-hour window (current − prior). */
  failures24hDelta: number;
}

/**
 * A test × environment matrix cell's derived status. `none` = the pairing has never run.
 * Otherwise the latest run for that pairing, mapped via {@link deriveRunOutcome}
 * (`passed` / `baseline` / `pending-baseline` / `regression` / `failed`); `queued`/`running`
 * collapse to `running`.
 */
export type MatrixCellStatus =
  | "passed"
  | "baseline"
  | "pending-baseline"
  | "healed"
  | "regression"
  | "failed"
  | "running"
  | "cancelled"
  | "none";

/** One cell of the dashboard matrix: the latest run's status for a (test, env). */
export interface MatrixCell {
  /** Environment name this cell is for (matches a `DashboardMatrix.environments` entry). */
  environment: string;
  status: MatrixCellStatus;
  /** The latest run to open on click; null when the pairing has never run (`none`). */
  runId: string | null;
}

/** One matrix row: a test and its per-environment cells (aligned to the column order). */
export interface MatrixRow {
  testId: string;
  testName: string;
  /** One cell per environment, in `DashboardMatrix.environments` order. */
  cells: MatrixCell[];
}

/**
 * The hero test × environment status matrix — one cell per (test, environment),
 * each the latest run's outcome. Columns are the environments that have any run
 * ("default" for env-less runs); rows are the tests that have any run.
 */
export interface DashboardMatrix {
  /** Column order — environment names that have at least one run. */
  environments: string[];
  rows: MatrixRow[];
}

/**
 * One checkpoint's diff-score trend over the last 14 days — the data behind a
 * dashboard sparkline. The series is the per-run mismatch ratio in run order, so a
 * checkpoint drifting toward its threshold stands out before it fails.
 */
export interface CheckpointTrend {
  checkpointName: string;
  /** The owning test (the same checkpoint name can exist in different tests). */
  testName: string;
  /** Diff scores (mismatch ratio in [0,1]) over the last 14 days, oldest→newest. */
  points: number[];
  /** The most recent diff score in the series. */
  latestScore: number;
  /** Severity band of the latest score (danger ≥ 5%, warning ≥ 1%, else success). */
  tone: "success" | "warning" | "danger";
}

/**
 * The run dashboard read-model — assembled derive-on-read from runs/run_results/
 * tests/environments (no stored aggregate, no new table): the KPI summary, the test
 * × environment status matrix, the recent-runs activity feed, and the per-checkpoint
 * diff-trend sparklines.
 */
export interface DashboardView {
  summary: DashboardSummary;
  matrix: DashboardMatrix;
  /** Newest standalone runs (suite-run children excluded, as in the Runs history). */
  recentRuns: RunSummary[];
  /** The most-relevant checkpoint diff trends (worst latest score first). */
  trends: CheckpointTrend[];
}
