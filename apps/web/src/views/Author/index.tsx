import type { AuthoringDraftEvent, AuthoringFrame, McpStatus } from "@varys/review-contract";
import { Badge, Button, Check, cx, EmptyState, ErrorState, Eye, Pencil, Skeleton, X } from "@varys/ui";
import { type ReactNode, useEffect, useState } from "react";
import { API_BASE } from "../../api";
import { LiveIndicator } from "../../components/LiveIndicator";
import { ZoomableImage } from "../../components/ZoomableImage";
import { useRouter } from "../../context/router";
import { useAuthoringSessions, useMcpStatus } from "../../queries";
import styles from "./styles.module.scss";

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

const isCheckpoint = (s: Step) => s.type === "screenshot";

function relativeAgo(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

/** Activity-based "is Claude Code driving" pill (stateless MCP → reflects recent requests). */
function McpStatusStrip({ status }: { status?: McpStatus }) {
  const connected = status?.connected ?? false;
  const lastSeen = status?.lastSeenAt ?? null;
  const label = connected ? "active" : lastSeen ? "idle" : "not connected";
  return (
    <div className={styles.statusBar}>
      <span className={cx(styles.statusDot, connected && styles.statusDotOn)} aria-hidden />
      <span className={styles.statusText}>
        Claude Code <strong>{label}</strong>
        {lastSeen && !connected ? ` · last action ${relativeAgo(lastSeen)}` : ""}
      </span>
      <span className={styles.statusNote}>reflects recent MCP activity</span>
    </div>
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
  const steps = useSteps(session?.sessionId ?? null, setDraft);

  // When switching sessions, follow the live (latest) step again.
  useEffect(() => setPickedSeq(null), [session?.sessionId]);

  const current = (pickedSeq != null ? steps.find((s) => s.seq === pickedSeq) : steps[steps.length - 1]) ?? steps[steps.length - 1] ?? null;

  let content: ReactNode;
  if (sessions.isLoading) {
    content = (
      <div className={styles.loading}>
        {[0, 1].map((i) => (
          <Skeleton key={i} height={140} radius="var(--radius-xl)" />
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
    content = (
      <EmptyState
        icon={<Pencil />}
        tone="neutral"
        title="No active authoring session"
        description="In your terminal, point Claude Code at Varys — `claude mcp add --transport http varys http://localhost:4000/mcp` — then tell it what to author, however you like: “open the dashboard, log in, click Reports, screenshot it.” Each step streams here with its screenshot, and finishing turns it into a draft."
      />
    );
  } else {
    content = (
      <>
        <div className={styles.head}>
          <span className={styles.headName}>{session.name}</span>
          <LiveIndicator label="Live" />
          <span className={styles.headMeta}>
            {session.stepCount} steps · {session.checkpointCount} checkpoint{session.checkpointCount === 1 ? "" : "s"}
          </span>
        </div>

        <div className={styles.grid}>
          {/* left: per-step timeline (each step + its screenshot) */}
          <div className={styles.timeline}>
            {steps.length === 0 ? (
              <div className={styles.timelineEmpty}>Steps appear here as Claude drives the page…</div>
            ) : (
              [...steps].reverse().map((s) => (
                <button
                  type="button"
                  key={s.seq}
                  className={cx(styles.step, current?.seq === s.seq && styles.stepOn, isCheckpoint(s) && styles.stepCheckpoint)}
                  onClick={() => setPickedSeq(s.seq)}
                >
                  <img className={styles.stepThumb} src={s.screenshot} alt="" loading="lazy" />
                  <span className={styles.stepBody}>
                    <span className={styles.stepLabel}>
                      <span className={styles.stepSeq}>{s.seq}</span>
                      {stepLabel(s)}
                      {isCheckpoint(s) && (
                        <Badge tone="primary" appearance="soft" size="sm">
                          Checkpoint
                        </Badge>
                      )}
                    </span>
                    <span className={styles.stepTime}>{relativeAgo(s.at)}</span>
                  </span>
                </button>
              ))
            )}
          </div>

          {/* right: the selected step's screenshot, large */}
          <div className={styles.viewer}>
            {current ? (
              <>
                <div className={styles.viewerHead}>
                  <span className={styles.viewerTitle}>{stepLabel(current)}</span>
                  {isCheckpoint(current) ? (
                    <Badge tone="primary" appearance="soft" size="sm">
                      Asserted by the test
                    </Badge>
                  ) : (
                    <Badge tone="neutral" appearance="soft" size="sm">
                      Live preview
                    </Badge>
                  )}
                </div>
                <div className={styles.viewerUrl}>{current.url}</div>
                <div className={styles.frame}>
                  <ZoomableImage
                    src={current.screenshot}
                    alt={stepLabel(current)}
                    className={styles.frameTrigger}
                    imgClassName={styles.frameImg}
                  />
                </div>
                <p className={styles.note}>
                  Varys captures a screenshot after each action so you can watch — these previews
                  aren’t saved. The steps marked <strong>Checkpoint</strong> are the test’s actual
                  visual assertions, and become the baselines you review.
                </p>
              </>
            ) : (
              <div className={styles.framePlaceholder}>
                <Eye size={20} />
                Waiting for the first action…
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className={styles.page}>
      <McpStatusStrip status={mcp.data} />

      {draft && (
        <div className={styles.banner}>
          <span className={styles.bannerIcon}>
            <Check size={16} />
          </span>
          <span className={styles.bannerText}>
            Draft <strong>“{draft.name}”</strong> created · {draft.checkpointCount} checkpoint
            {draft.checkpointCount === 1 ? "" : "s"}
          </span>
          <Button onClick={() => navigate({ name: "drafts" })}>Review it</Button>
          <button type="button" className={styles.bannerDismiss} onClick={() => setDraft(null)} aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      )}

      {content}
    </div>
  );
}
