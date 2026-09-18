import type { AuthoringDraftEvent, AuthoringFrame, McpStatus } from "@varys/review-contract";
import {
  Activity,
  Badge,
  Button,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  cx,
  ErrorState,
  Eye,
  Globe,
  type IconProps,
  Image,
  Info,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  MousePointer,
  Pencil,
  Skeleton,
  Sliders,
  X,
} from "@varys/ui";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { API_BASE, API_ORIGIN } from "../../api";
import { ZoomableImage } from "../../components/ZoomableImage";
import { AgentDrivenAuthoring } from "./components/AgentDriven";
import { useRouter } from "../../context/router";
import { useToast } from "../../context/toast";
import {
  useAuthoringInstructions,
  useAuthoringSessions,
  useMcpStatus,
  useSaveAuthoringInstructions,
} from "../../queries";
import styles from "./styles.module.scss";

/** The shell command that points a user's own Claude Code at Varys's MCP server. The MCP server
 *  IS the API, so it is named by the same origin a Bridge Helper would be pointed at. */
const CONNECT_CMD = `claude mcp add --transport http varys ${API_ORIGIN}/mcp`;

/** One captured step of a live session: the action Claude took + the screenshot taken right
 *  after it. A `checkpoint` name marks the steps that become the test's visual assertions. */
interface Step {
  seq: number;
  type: string;
  checkpoint?: string;
  url: string;
  screenshot: string;
  at: number;
}

/**
 * Subscribe to one Authoring Session's live stream (Slice 01/15): per-step frames, plus a
 * terminal `draft` event when the session finishes (handed to `onDraft`). Re-subscribes when the
 * session changes; closes on unmount. The server seeds the current frame on connect.
 */
function useSteps(sessionId: string | null, onDraft: (d: AuthoringDraftEvent) => void): Step[] {
  const [steps, setSteps] = useState<Step[]>([]);
  useEffect(() => {
    setSteps([]);
    if (!sessionId) return;
    const es = new EventSource(`${API_BASE}/authoring/sessions/${encodeURIComponent(sessionId)}/stream`, {
      withCredentials: true,
    });
    es.onmessage = (e) => {
      let f: AuthoringFrame;
      try {
        f = JSON.parse(e.data) as AuthoringFrame;
      } catch {
        return;
      }
      if (!f || f.sessionId !== sessionId) return;
      setSteps((prev) => {
        if (prev.length > 0 && prev[prev.length - 1].seq >= f.seq) return prev;
        const step: Step = { seq: f.seq, type: f.recorded.type, checkpoint: f.recorded.checkpoint, url: f.url, screenshot: f.screenshot, at: Date.now() };
        return [...prev, step].slice(-60);
      });
    };
    es.addEventListener("draft", (e) => {
      try {
        onDraft(JSON.parse((e as globalThis.MessageEvent).data) as AuthoringDraftEvent);
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [sessionId, onDraft]);
  return steps;
}

const isCheckpoint = (s: Step) => s.type === "screenshot";

function stepLabel(s: Step): string {
  switch (s.type) {
    case "navigate":
      return "Navigated";
    case "click":
      return "Clicked";
    case "type":
      return "Typed";
    case "screenshot":
      return s.checkpoint ? `Checkpoint “${s.checkpoint}”` : "Screenshot";
    default:
      return s.type;
  }
}

/** The line-glyph that fronts a step in the timeline, by action type. */
function stepGlyph(s: Step): (p: IconProps) => ReactNode {
  if (isCheckpoint(s)) return Camera;
  switch (s.type) {
    case "navigate":
      return Globe;
    case "click":
      return MousePointer;
    case "type":
      return Pencil;
    default:
      return Activity;
  }
}

function relativeAgo(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

/** Activity-based "is Claude Code driving" pill (stateless MCP → reflects recent requests). */
function ConnectionPill({ status }: { status?: McpStatus }) {
  const connected = status?.connected ?? false;
  const lastSeen = status?.lastSeenAt ?? null;
  const state = connected ? "active" : lastSeen ? "idle" : "not connected";
  const tone = connected ? "active" : lastSeen ? "idle" : "off";
  return (
    <div className={styles.connPill} data-state={tone}>
      <span className={styles.connDot} aria-hidden>
        <span className={styles.connDotInner} />
      </span>
      <span className={styles.connText}>
        <span className={styles.connTitle}>
          Claude Code <span className={styles.connState}>· {state}</span>
        </span>
        <span className={styles.connSub}>reflects recent activity</span>
      </span>
    </div>
  );
}

/** One example line of what to say to Claude (a violet ›-chevron + text). */
function ExampleLine({ children }: { children: ReactNode }) {
  return (
    <div className={styles.briefLine}>
      <span className={styles.briefChevron}>›</span>
      <span>{children}</span>
    </div>
  );
}

/** Connect / empty state — how to point your own Claude Code at Varys and what to say to it. */
function ConnectState() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(CONNECT_CMD).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  };
  return (
    <div className={styles.connect}>
      <div className={styles.connectGlow} aria-hidden />

      {/* intro */}
      <div className={styles.intro}>
        <span className={styles.connectIcon}>
          <Pencil size={28} />
        </span>
        <div className={styles.introHead}>
          <span className={styles.idle}>
            <span className={styles.idleDot} />
            Idle
          </span>
          <div className={styles.connectTitle}>No active authoring session</div>
        </div>
        <p className={styles.connectDesc}>
          Connect your Claude Code to Varys, then describe the whole flow in plain language — or
          point it at a plan file. Claude drives a real browser on the server, walks the brief end to
          end and saves the draft itself; every step and checkpoint streams in here.
        </p>
      </div>

      {/* step 1 — connect */}
      <div className={styles.step}>
        <div className={styles.stepLabel}>
          <span className={styles.stepNum}>1</span>
          <span className={styles.stepLabelText}>Connect Claude Code</span>
        </div>
        <div className={styles.term}>
          <div className={styles.termBar}>
            <span className={cx(styles.termLight, styles.termRed)} />
            <span className={cx(styles.termLight, styles.termAmber)} />
            <span className={cx(styles.termLight, styles.termGreen)} />
            <span className={styles.termLabel}>terminal</span>
          </div>
          <div className={styles.termBody}>
            <span className={styles.termCmd}>
              <span className={styles.termPrompt}>$</span> {CONNECT_CMD}
            </span>
            <button type="button" className={styles.termCopy} onClick={copy} aria-label="Copy command">
              {copied ? <Check size={14} /> : <CopyGlyph />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>

      {/* step 2 — hand over the brief */}
      <div className={styles.step}>
        <div className={styles.stepLabel}>
          <span className={styles.stepNum}>2</span>
          <span className={styles.stepLabelText}>Tell it what to test</span>
          <span className={styles.stepLabelSub}>— the whole thing, up front</span>
        </div>
        <div className={styles.briefCard}>
          <div className={styles.briefDesc}>
            Give Claude the entire brief in one go — typed out, or a plan file to read. It opens the
            session, walks every step without stopping to check in, captures the checkpoints the
            brief asks for, and finishes the draft on its own. There is nothing to choose before it
            starts and nothing to say to make it stop.
          </div>
          <div className={styles.briefExample}>
            <ExampleLine>
              Author a Varys test: open the dashboard, log in as a standard user, click{" "}
              <strong>Reports</strong>, and screenshot the revenue chart as a checkpoint
            </ExampleLine>
            <ExampleLine>
              …or: Author a Varys test from <strong>./plans/reports.md</strong>
            </ExampleLine>
          </div>
          <div className={styles.briefShortcut}>
            <span className={styles.briefShortcutLabel}>Shortcut</span>
            <code className={styles.briefShortcutCode}>{"/varys-author <url-or-plan-file>"}</code>
          </div>
        </div>
      </div>

      {/* checkpoints note */}
      <div className={styles.connectNote}>
        <span className={styles.connectNoteIcon}>
          <Info size={15} />
        </span>
        <span>
          Checkpoints — the test’s visual assertions — are captured <strong>only</strong> where you
          explicitly say “screenshot”, “capture”, or “checkpoint”. Everything else is just navigation.
        </span>
      </div>

      {/* waiting footer */}
      <div className={styles.connectWait}>
        <span className={styles.connectWaitDot} />
        Waiting for a session — this view goes live the moment Claude connects.
      </div>
    </div>
  );
}

/** A small clipboard glyph (local to the connect card; not in the shared icon set). */
function CopyGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/**
 * Editor for the AI authoring instructions (the MCP `initialize` prompt), in two layers served to
 * Claude as base + additional. Edits are stored server-side and served on the next connect — no
 * redeploy. "Additional" (team guidance) is the prominent, frequently-edited field; "Base" (the
 * foundational prompt — the authoring discipline, checkpoint discipline) sits in a collapsed
 * advanced section since
 * it changes rarely. When the additional layer is env-locked it's shown read-only.
 */
function InstructionsEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useAuthoringInstructions({ enabled: open });
  const save = useSaveAuthoringInstructions();
  const { toast } = useToast();
  const [additional, setAdditional] = useState("");
  const [base, setBase] = useState("");
  const [baseOpen, setBaseOpen] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Seed both drafts once per open from the loaded value; reset on close.
  useEffect(() => {
    if (!open) {
      setSeeded(false);
      setBaseOpen(false);
      return;
    }
    if (!seeded && data) {
      setAdditional(data.additional);
      setBase(data.base);
      setSeeded(true);
    }
  }, [open, seeded, data]);

  const additionalDirty = data ? additional !== data.additional : false;
  const baseDirty = data ? base !== data.base : false;
  const dirty = additionalDirty || baseDirty;
  const envLocked = data?.additionalLockedByEnv ?? false;

  const onSave = () => {
    const body: { base?: string; additional?: string } = {};
    if (baseDirty) body.base = base;
    if (additionalDirty && !envLocked) body.additional = additional;
    save.mutate(body, {
      onSuccess: () => {
        toast("Instructions saved");
        onClose();
      },
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t save"),
    });
  };

  return (
    <Modal open={open} onClose={onClose} width={760} labelledBy="authoring-instructions-title">
      <ModalHeader
        icon={<Sliders />}
        title="Authoring instructions"
        titleId="authoring-instructions-title"
        subtitle="The guidance Claude Code receives on connect. Edits take effect the next time it connects."
        onClose={onClose}
      />
      <ModalBody>
        {!data ? (
          <Skeleton height={340} radius="var(--radius-md)" />
        ) : (
          <>
            {/* Additional — the frequently-edited layer, front and centre. */}
            <div className={styles.instrField}>
              <div className={styles.instrLabel}>Additional instructions</div>
              <p className={styles.instrHelp}>
                Team-specific guidance, appended to the base. Edit this freely — it’s where
                per-project rules live.
              </p>
              <textarea
                className={styles.instrEditor}
                value={additional}
                onChange={(e) => setAdditional(e.target.value)}
                disabled={envLocked}
                spellCheck={false}
                placeholder="e.g. Our app’s login is at /auth. Prefer element checkpoints over full-page."
                aria-label="Additional instructions"
              />
              {envLocked && (
                <div className={styles.instrNote}>
                  <Info size={14} />
                  <span>
                    Set via environment (a deployment lock) and appended on top — it can’t be edited
                    here.
                  </span>
                </div>
              )}
            </div>

            {/* Base — the foundational prompt; rarely changed, so tucked behind a toggle. */}
            <button
              type="button"
              className={styles.instrAdvancedToggle}
              aria-expanded={baseOpen}
              onClick={() => setBaseOpen((v) => !v)}
            >
              <ChevronRight size={14} className={cx(styles.instrChevron, baseOpen && styles.instrChevronOpen)} />
              Base instructions
              <span className={styles.instrAdvancedHint}>
                · the foundational prompt — change rarely{data.baseUsingDefault ? "" : " · customised"}
              </span>
            </button>
            {baseOpen && (
              <div className={styles.instrField}>
                <p className={styles.instrHelp}>
                  The core contract (the authoring discipline, the checkpoint discipline). Changing
                  this affects
                  how every test is authored — edit with care.{" "}
                  {!data.baseUsingDefault && (
                    <button
                      type="button"
                      className={styles.instrResetInline}
                      onClick={() => setBase(data.baseDefault)}
                    >
                      Reset to default
                    </button>
                  )}
                </p>
                <textarea
                  className={styles.instrEditor}
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  spellCheck={false}
                  aria-label="Base instructions"
                />
              </div>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={save.isPending} disabled={!dirty} onClick={onSave}>
          Save
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** Which kind of test this Author session is meant to produce. Remembered across reloads so a
 *  refresh mid-conversation does not silently put the page back on the other path. */
const KIND_STORAGE_KEY = "varys.author.kind";

type AuthoringKind = "pinned" | "agent";

function readStoredKind(): AuthoringKind {
  try {
    return window.localStorage.getItem(KIND_STORAGE_KEY) === "agent" ? "agent" : "pinned";
  } catch {
    return "pinned";
  }
}

/**
 * The kind choice, made BEFORE the conversation starts — and locked once one is under way,
 * because Claude picks its tools on the first tool call and there is no coherent midpoint.
 *
 * Knowing a conversation IS under way works differently per kind, and has to. A pinned one opens
 * an Authoring Session Varys can see, so the picker simply disappears behind the live view. An
 * Agent-Driven one opens nothing — no session, no browser, no state Varys holds — so the only
 * evidence available is the Draft moving, which the panel below watches for.
 *
 * It has to come first because the two paths share no mechanism: a pinned test is recorded by a
 * browser Varys drives, an Agent-Driven one is explored by Claude on the author's own machine and
 * written down as prose. Claude picks its tools on the first call, so this is a decision with no
 * sensible midpoint.
 *
 * It is a **steer, not an enforcement**, and the copy says so rather than implying a guarantee
 * Varys does not make: `/mcp` filters tools by who is asking, not by what this page is set to, and
 * authoring has no session object to hang a mode on. What this changes is the guidance below and
 * what you are told to say to Claude. Getting it wrong produces a Draft you delete, not a
 * corrupted test.
 *
 * The cost difference is stated because it is the author's money and it is not recoverable later:
 * a pinned test replays on Varys's own worker for free, while every single run of an Agent-Driven
 * Test spends their Claude subscription quota.
 */
function KindChoice({
  kind,
  onChange,
  locked,
}: {
  kind: AuthoringKind;
  onChange: (k: AuthoringKind) => void;
  /** A conversation is already under way, so the question is settled for the rest of it. */
  locked: boolean;
}) {
  const options: { id: AuthoringKind; title: string; tag: string; desc: string; cost: string }[] = [
    {
      id: "pinned",
      title: "Pinned test",
      tag: "recorded",
      desc: "Claude drives a browser on Varys's server and records the steps. Replayed exactly, every run. Needs a DOM stable enough to pin to.",
      cost: "Runs free on Varys's worker.",
    },
    {
      id: "agent",
      title: "Agent-Driven Test",
      tag: "re-walked",
      desc: "Claude explores your app with its own local tooling and writes AI Instructions and Checkpoints. For flows that will not sit still — charts that redraw, figures that move.",
      cost: "Every run spends your Claude subscription quota.",
    },
  ];

  return (
    <section className={styles.kindPicker}>
      <div className={styles.kindHead}>
        <span className={styles.kindLabel}>What should Claude author?</span>
        <span className={styles.kindHint}>
          {locked
            ? "Claude is already authoring — this is settled for the rest of the conversation."
            : "Pick before you start. Claude chooses its tools on the first call, so there is no switching part-way."}
        </span>
      </div>
      <div className={styles.kindOptions}>
        {options.map((o) => (
          <button
            type="button"
            key={o.id}
            className={cx(styles.kindCard, kind === o.id && styles.kindCardOn)}
            aria-pressed={kind === o.id}
            disabled={locked}
            onClick={() => onChange(o.id)}
          >
            <span className={styles.kindCardHead}>
              <span className={styles.kindCardTitle}>{o.title}</span>
              <span className={styles.kindCardTag}>{o.tag}</span>
              {kind === o.id && <Check size={15} className={styles.kindCardTick} />}
            </span>
            <span className={styles.kindCardDesc}>{o.desc}</span>
            <span className={cx(styles.kindCardCost, o.id === "agent" && styles.kindCardCostWarn)}>
              {o.cost}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Author with AI (Slice 15) — drive authoring from your own Claude Code (your subscription,
 * first-party) and watch it here step by step. Each action Claude takes against Varys's MCP
 * server shows with the screenshot captured right after it; the steps marked **Checkpoint** are
 * the test's actual visual assertions. When the session finishes it becomes a Draft, and a
 * "Review it" hand-off links straight to the review queue.
 */
export function Author() {
  const sessions = useAuthoringSessions();
  const mcp = useMcpStatus();
  const { navigate } = useRouter();
  const [pickedSeq, setPickedSeq] = useState<number | null>(null);
  const [draft, setDraft] = useState<AuthoringDraftEvent | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [kind, setKind] = useState<AuthoringKind>(readStoredKind);
  // Set once this page sees an Agent-Driven Draft actually moving — see `KindChoice`. Never
  // cleared: within one visit, a conversation that started does not un-start.
  const [agentWriting, setAgentWriting] = useState(false);
  const onAgentWriting = useCallback(() => setAgentWriting(true), []);

  const chooseKind = useCallback((k: AuthoringKind) => {
    setKind(k);
    try {
      window.localStorage.setItem(KIND_STORAGE_KEY, k);
    } catch {
      /* a browser refusing storage is not worth failing the page over */
    }
  }, []);

  const all = sessions.data ?? [];
  // Just the live one: the most recent active session (no multi-session history).
  const session = all.length > 0 ? all[all.length - 1] : null;
  const onDraft = useCallback((d: AuthoringDraftEvent) => setDraft(d), []);
  const steps = useSteps(session?.sessionId ?? null, onDraft);

  // When switching sessions, follow the live (latest) step again.
  useEffect(() => setPickedSeq(null), [session?.sessionId]);

  const following = pickedSeq == null;
  const current = (following ? steps[steps.length - 1] : steps.find((s) => s.seq === pickedSeq)) ?? steps[steps.length - 1] ?? null;
  const currentIsCp = current ? isCheckpoint(current) : false;

  let content: ReactNode;
  if (sessions.isLoading) {
    content = (
      <div className={styles.loading}>
        {[0, 1].map((i) => (
          <Skeleton key={i} height={180} radius="var(--radius-xl)" />
        ))}
      </div>
    );
  } else if (sessions.isError) {
    content = (
      <ErrorState
        title="Couldn’t load authoring sessions"
        description="GET /authoring/sessions failed — this is a temporary read failure."
        onRetry={() => sessions.refetch()}
      />
    );
  } else if (!session) {
    // No Varys-hosted session. Which of the two paths this page is for is the author's choice,
    // and the agent-driven one never opens a session at all — Varys hosts no browser for it, so
    // there is nothing to wait for and nothing to preview.
    content =
      kind === "agent" ? (
        <AgentDrivenAuthoring connectCmd={CONNECT_CMD} onWriting={onAgentWriting} />
      ) : (
        <ConnectState />
      );
  } else {
    content = (
      <div className={styles.grid}>
        {/* ===== left: per-step timeline ===== */}
        <div className={styles.timeline}>
          <div className={styles.timelineHead}>
            <span className={styles.timelineTitle}>Timeline</span>
            {mcp.data?.connected && (
              <span className={styles.streamBadge}>
                <span className={styles.streamDot} />
                streaming
              </span>
            )}
            <span className={styles.spacer} />
            {following ? (
              <span className={styles.followNote}>
                <Activity size={13} />
                Following latest
              </span>
            ) : (
              <button type="button" className={styles.jumpLatest} onClick={() => setPickedSeq(null)}>
                <ChevronDown size={13} />
                Jump to latest
              </button>
            )}
          </div>

          <div className={styles.timelineBody}>
            {steps.length === 0 ? (
              <div className={styles.timelineEmpty}>Steps appear here as Claude drives the page…</div>
            ) : (
              [...steps].reverse().map((s) => {
                const cp = isCheckpoint(s);
                const Glyph = stepGlyph(s);
                const selected = current?.seq === s.seq;
                return (
                  <button
                    type="button"
                    key={s.seq}
                    className={cx(styles.row, selected && styles.rowOn, cp && styles.rowCheckpoint)}
                    onClick={() => setPickedSeq(s.seq)}
                  >
                    <span className={styles.rowSeq}>{s.seq}</span>
                    <span className={styles.rowThumb}>
                      <Image imgClassName={styles.rowThumbImg} src={s.screenshot} alt="" loading="lazy" />
                      {cp && (
                        <span className={styles.rowThumbCp} aria-hidden>
                          <Camera size={9} />
                        </span>
                      )}
                    </span>
                    <span className={styles.rowMain}>
                      <span className={styles.rowLabelLine}>
                        <span className={cx(styles.rowGlyph, cp && styles.rowGlyphCp)}>
                          <Glyph size={13} />
                        </span>
                        <span className={cx(styles.rowLabel, cp && styles.rowLabelCp)}>{stepLabel(s)}</span>
                      </span>
                      <span className={styles.rowMeta}>
                        {cp && (
                          <Badge tone="primary" appearance="soft" size="sm">
                            Checkpoint
                          </Badge>
                        )}
                        <span className={styles.rowTime}>{relativeAgo(s.at)}</span>
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ===== right: the selected step's screenshot, large ===== */}
        <div className={styles.viewer}>
          <div className={styles.viewerCard}>
            {current ? (
              <>
                <div className={styles.viewerHead}>
                  <div className={styles.viewerHeadMain}>
                    <div className={styles.viewerTitle}>{stepLabel(current)}</div>
                    <div className={styles.viewerUrl}>
                      <Globe size={13} className={styles.viewerUrlIcon} />
                      <span className={styles.viewerUrlText}>{current.url}</span>
                    </div>
                  </div>
                  {currentIsCp ? (
                    <Badge tone="primary" appearance="soft" icon={<Camera />}>
                      Asserted by the test
                    </Badge>
                  ) : (
                    <Badge tone="neutral" appearance="soft" icon={<Eye />}>
                      Live preview
                    </Badge>
                  )}
                </div>

                <div className={styles.shotWrap}>
                  <div className={styles.browser}>
                    <div className={styles.browserBar}>
                      <span className={cx(styles.light, styles.lightRed)} />
                      <span className={cx(styles.light, styles.lightAmber)} />
                      <span className={cx(styles.light, styles.lightGreen)} />
                      <span className={styles.browserUrl}>{current.url}</span>
                    </div>
                    <div className={styles.browserBody}>
                      <ZoomableImage
                        src={current.screenshot}
                        alt={stepLabel(current)}
                        caption={stepLabel(current)}
                        hintLabel="Click to zoom"
                        className={styles.shotTrigger}
                        imgClassName={styles.shotImg}
                      />
                    </div>
                  </div>
                </div>

                <div className={styles.note}>
                  <Info size={15} className={styles.noteIcon} />
                  <span className={styles.noteText}>
                    Live previews are captured after each action so you can watch; they aren’t saved.
                    The steps marked <strong>Checkpoint</strong> are the test’s assertions and become
                    the baselines you review.
                  </span>
                </div>
              </>
            ) : (
              <div className={styles.framePlaceholder}>
                <Eye size={20} />
                Waiting for the first action…
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <InstructionsEditor open={editorOpen} onClose={() => setEditorOpen(false)} />

      {/* control row: session header (when live) + instructions editor + connection pill */}
      <div className={styles.controlRow}>
        {session && (
          <div className={styles.sessionHead}>
            <div className={styles.sessionTitleRow}>
              <span className={styles.sessionName}>{session.name}</span>
              <span className={styles.livePill}>
                <span className={styles.livePillDot} />
                Live
              </span>
            </div>
            <div className={styles.sessionCounts}>
              {session.stepCount} steps · {session.checkpointCount} checkpoint
              {session.checkpointCount === 1 ? "" : "s"}
            </div>
          </div>
        )}
        <span className={styles.spacer} />
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Sliders size={15} />}
          onClick={() => setEditorOpen(true)}
        >
          Instructions
        </Button>
        <ConnectionPill status={mcp.data} />
      </div>

      {/* The kind choice sits above everything, and disappears once a Varys-hosted session is
          live: at that point the question is settled by a conversation already under way. The
          agent-driven path never opens one, so it is locked in place rather than hidden. */}
      {!session && <KindChoice kind={kind} onChange={chooseKind} locked={agentWriting} />}

      {draft && (
        <div className={styles.banner}>
          <span className={styles.bannerIcon}>
            <Check size={22} />
          </span>
          <div className={styles.bannerBody}>
            <div className={styles.bannerTitle}>Draft “{draft.name}” created</div>
            <div className={styles.bannerSub}>
              {draft.checkpointCount} checkpoint{draft.checkpointCount === 1 ? "" : "s"} captured · saved to
              the review queue, ready to promote into a baseline.
            </div>
          </div>
          <Button onClick={() => navigate({ name: "drafts" })}>
            Review it <ChevronRight size={15} />
          </Button>
          <button type="button" className={styles.bannerDismiss} onClick={() => setDraft(null)} aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      )}

      {content}
    </div>
  );
}
