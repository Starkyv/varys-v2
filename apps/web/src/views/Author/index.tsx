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
  Info,
  MousePointer,
  Pencil,
  Skeleton,
  Sparkles,
  X,
} from "@varys/ui";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { API_BASE } from "../../api";
import { ZoomableImage } from "../../components/ZoomableImage";
import { useRouter } from "../../context/router";
import { useAuthoringSessions, useMcpStatus } from "../../queries";
import styles from "./styles.module.scss";

/** The shell command that points a user's own Claude Code at Varys's MCP server. */
const CONNECT_CMD = "claude mcp add --transport http varys http://localhost:4000/mcp";

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
      <span className={styles.connectIcon}>
        <Pencil size={30} />
      </span>
      <div className={styles.connectTitle}>No active authoring session</div>
      <p className={styles.connectDesc}>
        Connect your own Claude Code to Varys, then describe the flow you want to test in plain
        language. Claude drives a real browser on the server — every step and checkpoint streams in
        here.
      </p>

      <div className={styles.steps}>
        <div className={styles.connectStep}>
          <div className={styles.connectStepLabel}>
            <span className={styles.stepNum}>1</span>Connect Claude Code
          </div>
          <div className={styles.cmd}>
            <span className={styles.cmdText}>
              <span className={styles.cmdPrompt}>$</span> {CONNECT_CMD}
            </span>
            <button type="button" className={styles.cmdCopy} onClick={copy} title="Copy command" aria-label="Copy command">
              {copied ? <Check size={14} /> : <CopyGlyph />}
            </button>
          </div>
        </div>
        <div className={styles.connectStep}>
          <div className={styles.connectStepLabel}>
            <span className={styles.stepNum}>2</span>Tell it what to test
          </div>
          <div className={styles.example}>
            <span className={styles.exampleIcon}>
              <Sparkles size={16} />
            </span>
            <div className={styles.exampleText}>
              “Open the dashboard, log in as a standard user, click <strong>Reports</strong>, then
              take a screenshot of the revenue chart as a checkpoint.”
            </div>
          </div>
        </div>
      </div>

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
    content = <ConnectState />;
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
                      <img className={styles.rowThumbImg} src={s.screenshot} alt="" loading="lazy" />
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
      {/* control row: session header (when live) + connection pill */}
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
        <ConnectionPill status={mcp.data} />
      </div>

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
