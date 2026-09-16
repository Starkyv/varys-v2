import type { DraftSummary } from "@varys/review-contract";
import { Badge, Button, Camera, ChevronRight, Info, Skeleton, Sparkles } from "@varys/ui";
import { AgentCheckpointList } from "../../../../components/AgentCheckpointList";
import { useEffect, useRef } from "react";
import { useRouter } from "../../../../context/router";
import { relativeTime } from "../../../../lib/format";
import { useDraft, useDrafts } from "../../../../queries";
import styles from "./styles.module.scss";

/**
 * **Authoring an Agent-Driven Test** — the other half of Author with AI, and deliberately not
 * shaped like the pinned half.
 *
 * There is no session here and nothing to stream. Varys hosts no browser for this kind, during a
 * run or while authoring one, so Claude explores the app on the author's own machine with its own
 * tooling and Varys never sees the page. That removes the live preview outright rather than
 * leaving an empty frame where one used to be — an empty browser chrome would read as "the
 * preview is broken", which is a worse lie than saying there isn't one.
 *
 * What fills that space instead is the thing that IS accumulating: the Draft. It is in the review
 * queue from the moment Claude creates it, so its Checkpoints appear here one at a time as they
 * are written, and a pass abandoned half way leaves a visibly incomplete Draft rather than
 * nothing. Re-read on an interval, because there is no stream to subscribe to.
 */
export function AgentDrivenAuthoring({
  connectCmd,
  onWriting,
}: {
  connectCmd: string;
  /** Called once this page has evidence a conversation is actually under way. */
  onWriting: () => void;
}) {
  const drafts = useDrafts();
  // The newest Agent-Driven Draft: the one being written, if anything is being written.
  const authored = (drafts.data ?? []).filter((d) => d.kind === "agent");
  const latest = authored[0] ?? null;

  /**
   * Decide whether a conversation is under way — which this kind cannot simply be asked, because
   * it has no session object to ask. Varys hosts no browser for it and holds no state about it;
   * the only thing that moves is the Draft.
   *
   * So the signal is movement, observed by THIS page: the first poll establishes a baseline, and
   * any later change — a new Draft appearing, or a Checkpoint added to the one already there —
   * means Claude is writing right now. A Draft that merely exists proves nothing; it could be
   * from last week. Deliberately not persisted: a reload should re-establish the baseline rather
   * than leave the page believing a conversation is live because one once was.
   */
  const baseline = useRef<string | null>(null);
  useEffect(() => {
    if (!drafts.data) return; // nothing fetched yet — no baseline to compare against
    const signature = latest ? `${latest.id}:${latest.checkpointCount}` : "";
    if (baseline.current === null) {
      baseline.current = signature;
      return;
    }
    if (signature !== baseline.current) {
      baseline.current = signature;
      onWriting();
    }
  }, [drafts.data, latest, onWriting]);

  return (
    <div className={styles.wrap}>
      <Guidance connectCmd={connectCmd} />
      {latest ? <LiveDraft draft={latest} /> : <Waiting />}
    </div>
  );
}

/** What to say to Claude — this kind's equivalent of the pinned connect card's mode examples. */
function Guidance({ connectCmd }: { connectCmd: string }) {
  return (
    <section className={styles.guide}>
      <div className={styles.guideHead}>
        <span className={styles.guideIcon}>
          <Sparkles size={19} />
        </span>
        <div>
          <div className={styles.guideTitle}>Ask Claude to author the journey</div>
          <p className={styles.guideDesc}>
            Claude explores your app with its own tooling — a local dev server, a VPN’d staging, an
            SSO session only your machine can see — and writes what it finds straight into a Draft.
            Varys drives nothing and sees no page.
          </p>
        </div>
      </div>

      <div className={styles.guideExamples}>
        <div className={styles.guideLine}>
          <span className={styles.guideChevron}>›</span>
          <span>
            Author a Varys <strong>agent-driven</strong> test for the reports dashboard — sign in,
            filter to last 7 days, export
          </span>
        </div>
        <div className={styles.guideLine}>
          <span className={styles.guideChevron}>›</span>
          <span>
            Say <strong>agent-driven</strong> explicitly. Claude has tools for both kinds and will
            not guess which one you want.
          </span>
        </div>
      </div>

      <div className={styles.guideNote}>
        <Info size={15} className={styles.guideNoteIcon} />
        <span>
          Claude must capture a screenshot for every Checkpoint it writes — Varys refuses one
          without a picture, so a state it never actually reached cannot be written down as if it
          had been. Not connected yet? <code className={styles.guideCode}>{connectCmd}</code>
        </span>
      </div>
    </section>
  );
}

/** Nothing authored yet — the counterpart of the pinned view's "waiting for a session". */
function Waiting() {
  return (
    <div className={styles.waiting}>
      <span className={styles.waitingDot} />
      No Draft yet — Checkpoints appear here as Claude writes them.
    </div>
  );
}

/** The Draft being written, re-read on an interval so its Checkpoints fill in. */
function LiveDraft({ draft }: { draft: DraftSummary }) {
  const { navigate } = useRouter();
  const detail = useDraft(draft.id, { pollMs: 3000 });
  const checkpoints = detail.data?.checkpoints ?? [];

  return (
    <section className={styles.draft}>
      <header className={styles.draftHead}>
        <div className={styles.draftTitleWrap}>
          <div className={styles.draftTitle}>{draft.name}</div>
          <div className={styles.draftSub}>
            {draft.checkpointCount} checkpoint{draft.checkpointCount === 1 ? "" : "s"} ·{" "}
            {relativeTime(draft.createdAt)}
          </div>
        </div>
        <Badge tone="neutral" appearance="soft" size="sm">
          Draft
        </Badge>
        <span className={styles.spacer} />
        <Button variant="secondary" size="sm" onClick={() => navigate({ name: "drafts" })}>
          Review it <ChevronRight size={15} />
        </Button>
      </header>

      {detail.data?.intent && (
        <div className={styles.instrBlock}>
          <span className={styles.instrLabel}>AI Instructions</span>
          <pre className={styles.instrText}>{detail.data.intent}</pre>
        </div>
      )}

      <div className={styles.cpHead}>
        <Camera size={14} />
        <span>Checkpoints</span>
        <span className={styles.spacer} />
        <span className={styles.writing}>
          <span className={styles.writingDot} />
          watching for new ones
        </span>
      </div>

      {detail.isLoading && checkpoints.length === 0 ? (
        <Skeleton height={96} radius="var(--radius-lg)" />
      ) : checkpoints.length === 0 ? (
        <div className={styles.cpEmpty}>
          The Draft exists but has no Checkpoints yet. Until it has at least one, a run on it is
          refused — there would be nothing to reach or compare.
        </div>
      ) : (
        <AgentCheckpointList checkpoints={checkpoints} />
      )}

      <p className={styles.draftNote}>
        These captures are reference images of what Claude saw, not baselines. The first run against
        an environment proposes the baselines, and you approve them there.
      </p>
    </section>
  );
}
