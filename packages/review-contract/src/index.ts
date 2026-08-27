/**
 * The shared, typed per-checkpoint review read-model — the single contract the
 * NestJS API produces and the `apps/web` review SPA consumes, so the two can't
 * silently drift (PRD: "build the read-model contract first").
 *
 * Pure types, zero runtime dependencies: the SPA imports this without dragging in
 * drizzle/pg or any Node-only code. The verdict (reviewState, diffScore) is computed
 * server-side and only *displayed* here — never recomputed on the client.
 */

/** The two states that need a human decision, plus the resolved `passed`. */
export type ReviewState = "pending-baseline" | "diff" | "passed";

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
 * One repaired version awaiting a human decision — the repair review queue (Slice 19, slice 04).
 * Deliberately thin: the side-by-side locator diff, the justification and the blast radius are
 * slice 13's job. What is here is enough to decide with: which test, which version, who wrote it,
 * what they said they did, and the Brief it was supposed to serve.
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
 *  the screenshot-only knobs (threshold). `supportsWaits` is false for navigate. */
export interface TestConfigStep {
  /** 0-based position in the definition's step list — the key a patch addresses this step by.
   *  Not stable across a patch that adds, removes or reorders steps: re-read the config after
   *  one of those before keying another edit off an index. */
  index: number;
  type: "navigate" | "click" | "hover" | "type" | "screenshot";
  /** Human label (same `describeStep` vocabulary as the run timeline). */
  label: string;
  /** False for navigate (no `waitBefore` in the schema); true otherwise. */
  supportsWaits: boolean;
  /** The waits the runner applies before this step (after the test-level defaults). */
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
  /** Number of checkpoints (screenshot steps) the draft asserts — 0 ⇒ flagged (a test
   *  that asserts nothing). */
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
  captureMode: CaptureMode;
  /** Authenticated artifact-route URL of the preview PNG; null if none was captured. */
  previewUrl: string | null;
}

/** The full Draft detail (`GET /drafts/:id`) — the summary plus every checkpoint's
 *  authoring preview, for a richer pre-promotion view. */
export interface DraftView {
  id: string;
  name: string;
  origin: TestOrigin;
  createdAt: string;
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

/** A command the web sends down to the Bridge Helper (server → helper). Prompts only for now;
 *  cancel/interrupt arrive in a later slice. */
export type BridgeCommand = { type: "prompt"; text: string };

/** What the Bridge Helper POSTs up to the relay (helper → server). `assistant`/`tool` are
 *  mirrored to the web verbatim; `session` correlates the Authoring Session and the relay turns
 *  it into a `status` event. */
export type BridgeHelperEvent =
  | { type: "assistant"; text: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "session"; sessionId: string };

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
  /** Why it needs review: `pending-baseline` (first approval) or `diff`. */
  reviewState: Exclude<ReviewState, "passed">;
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
  /** Distinct environment names the fan-out targeted ("default" when none). */
  environments: string[];
  /** Derived from the children: all-queued → queued; any queued/running →
   *  running; else failed > needs_review > passed. */
  status: string;
  counts: SuiteRunCounts;
  runTimestamp: string;
}

/** One child inside a suite-run report — an ordinary run, opened via `?run=`. */
export interface SuiteRunChild {
  runId: string;
  testName: string;
  /** Environment name this child ran against ("default" when none). */
  environment: string;
  status: string;
  /** Derived display outcome refining `status` (baseline vs verified, …), per
   *  {@link deriveRunOutcome}. The parent aggregate + counts stay on coarse `status`. */
  outcome: RunOutcome;
  error: string | null;
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
export type AssertionOutcome = "passed" | "relation-false" | "extraction-failed";

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
  /** Set only when `outcome` is `extraction-failed`. */
  cause: ExtractionCause | null;
  /** The two coerced values compared, rendered; null for a side that produced none. */
  left: string | null;
  right: string | null;
  /** The engine's one-line explanation — what was compared and what happened. */
  detail: string;
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
  /** The pinned form, or null when the assertion is declared but unpinned (never evaluated). */
  pinned: PinnedAssertionView | null;
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
  /** Test name, for display without a separate lookup. */
  testName: string;
  /** Environment name the run executed against ("default" when none was chosen). */
  environment: string;
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
 * Map a run's checkpoints + coarse `status` into a {@link RunOutcome}. Pure (no IO) — the single
 * definition every surface shares (run detail, runs list, dashboard matrix, suite report) so they
 * can't drift. `status` and the stored status column are unchanged; this only refines display.
 *
 * Precedence, top → down:
 *  1. queued / running                  → unchanged
 *  2. execution error                   → `failed`  (a crash)
 *  3. any unaccepted `diff` (or legacy `rejected`) → `regression`  (a baseline existed and changed)
 *  4. any unresolved first-capture seed → `pending-baseline`  (no baseline yet — awaiting approval)
 *  5. nothing was actually verified     → `failed`  (it captured nothing to compare)
 *  6. an unaccepted repair is in play   → `healed`  (it verified, but on an unreviewed repair)
 *  7. any checkpoint set as baseline    → `baseline`
 *  8. otherwise (all matched)           → `passed`
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

  let failing = false;
  let pendingSeed = false;
  let baselineWrite = false;
  let matched = false;

  for (const c of checkpoints) {
    if (c.resolution === "approved") baselineWrite = true; // promoted to baseline
    else if (c.resolution === "rejected") failing = true; // legacy: a confirmed bug stays red
    else if (c.reviewState === "diff") failing = true; // an established baseline changed
    else if (c.reviewState === "pending-baseline") pendingSeed = true; // first capture, no baseline yet
    else if (c.reviewState === "passed") matched = true;
  }

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
