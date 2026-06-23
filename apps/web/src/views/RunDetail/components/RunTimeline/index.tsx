import type { CheckpointView, RunView, StepRun } from "@varys/review-contract";
import {
  ArrowDownRight,
  Check,
  ChevronDown,
  Clock,
  cx,
  Dot,
  ExternalLink,
  Eye,
  type IconProps,
  Layers,
  Pencil,
  X,
} from "@varys/ui";
import { motion, useReducedMotion } from "framer-motion";
import { type ComponentType, type KeyboardEvent, useRef, useState } from "react";
import { duration, scorePct } from "../../../../lib/format";
import { TONE_VARS } from "../../../../lib/status";
import styles from "./styles.module.scss";

type IconType = ComponentType<IconProps>;
type BadgeTone = "success" | "danger" | "info" | "warning";

/* ------------------------------------------------------------------ *
 *  Row assembly — exported so the parent can derive the right pane    *
 *  from the same model the rail renders.                              *
 * ------------------------------------------------------------------ */

export interface TimelineRowBase {
  /** 0-based position in the run's steps — the stable selection key. */
  index: number;
  label: string;
  /** Unique React key (names can collide on legacy runs; suffix with index). */
  key: string;
}

export type TimelineRow =
  | (TimelineRowBase & {
      kind: "checkpoint";
      durationMs: number;
      outcome: StepRun["outcome"];
      failing: boolean;
      checkpoint: CheckpointView;
    })
  | (TimelineRowBase & { kind: "step"; durationMs: number; outcome: StepRun["outcome"]; failing: boolean })
  | (TimelineRowBase & { kind: "never" });

/** A checkpoint still awaiting a human decision (its rail badge stays actionable). */
export function needsDecision(cp: CheckpointView): boolean {
  return !cp.resolution && (cp.reviewState === "pending-baseline" || cp.reviewState === "diff");
}

/**
 * Build the chronological rail model: every executed step from `timeline`
 * (already ordered), with checkpoint steps joined to their `CheckpointView`,
 * then — for a failed run — the never-ran tail appended from the full step list.
 * Mirrors the join + never-ran logic the old `FailedRun`/`CheckpointList` used.
 */
export function buildTimelineRows(run: RunView): TimelineRow[] {
  const cpByName = new Map(run.checkpoints.map((c) => [c.name, c]));
  const rows: TimelineRow[] = [];

  run.timeline.forEach((t, i) => {
    const cp = t.checkpointName ? cpByName.get(t.checkpointName) : undefined;
    const failing = t.outcome === "failed";
    if (cp) {
      rows.push({
        kind: "checkpoint",
        index: t.index,
        label: t.label,
        key: `${t.checkpointName}-${t.index}`,
        durationMs: t.durationMs,
        outcome: t.outcome,
        failing,
        checkpoint: cp,
      });
    } else {
      rows.push({
        kind: "step",
        index: t.index,
        label: t.label,
        key: `step-${t.index}-${i}`,
        durationMs: t.durationMs,
        outcome: t.outcome,
        failing,
      });
    }
  });

  if (run.failedStepIndex != null) {
    const failedAt = run.failedStepIndex;
    run.steps
      .filter((s) => s.index > failedAt)
      .forEach((s) => rows.push({ kind: "never", index: s.index, label: s.label, key: `never-${s.index}` }));
  }

  return rows;
}

/** Default selection on load: first undecided checkpoint → failing step → first
 *  checkpoint → first step. */
export function defaultSelectedIndex(run: RunView, rows: TimelineRow[]): number {
  const need = rows.find((r) => r.kind === "checkpoint" && needsDecision(r.checkpoint));
  if (need) return need.index;
  if (run.failedStepIndex != null) return run.failedStepIndex;
  const firstCp = rows.find((r) => r.kind === "checkpoint");
  if (firstCp) return firstCp.index;
  return rows.length ? rows[0].index : 0;
}

/* ------------------------------------------------------------------ *
 *  Per-row visual derivations                                         *
 * ------------------------------------------------------------------ */

/** The state badge a checkpoint row carries (resolution overrides review state). Test-runner
 *  model: a diff or a not-yet-set baseline reads red, since both fail the run until set. */
export function checkpointBadge(cp: CheckpointView): { label: string; tone: BadgeTone; Icon: IconType } {
  if (cp.resolution === "approved") return { label: "Baseline set", tone: "success", Icon: Check };
  if (cp.resolution === "rejected") return { label: "Rejected", tone: "danger", Icon: X };
  if (cp.reviewState === "pending-baseline") return { label: "Pending baseline", tone: "warning", Icon: Layers };
  if (cp.reviewState === "diff") return { label: "Changed", tone: "danger", Icon: Eye };
  return { label: "Passed", tone: "success", Icon: Check };
}

const CAPTURE_LABEL: Record<CheckpointView["captureMode"], string> = {
  element: "element",
  fullpage: "full-page",
  region: "region",
};

/** A node glyph derived from the step's action verb (generic dot fallback). */
export function verbIcon(label: string): IconType {
  const l = label.toLowerCase().trim();
  if (l.startsWith("navigate") || l.startsWith("goto") || l.startsWith("open")) return ExternalLink;
  if (l.startsWith("type") || l.startsWith("fill") || l.startsWith("enter") || l.startsWith("press") || l.startsWith("input"))
    return Pencil;
  if (l.startsWith("wait") || l.startsWith("sleep") || l.startsWith("delay")) return Clock;
  if (l.startsWith("assert") || l.startsWith("expect") || l.startsWith("verify") || l.startsWith("check") || l.startsWith("see"))
    return Check;
  if (l.startsWith("select") || l.startsWith("choose") || l.startsWith("pick")) return ChevronDown;
  if (l.startsWith("scroll")) return ArrowDownRight;
  if (l.startsWith("hover")) return Eye;
  return Dot;
}

const NODE = {
  checkpoint: { size: 32, center: "28px" },
  step: { size: 28, center: "22px" },
} as const;

/* ------------------------------------------------------------------ *
 *  Lazy screenshot thumbnail — the run's *actual* capture             *
 * ------------------------------------------------------------------ */

function Thumb({ src, alt, alert }: { src: string | null; alt: string; alert: boolean }) {
  const [status, setStatus] = useState<"loading" | "ok" | "error">(src ? "loading" : "error");
  return (
    <div className={cx(styles.thumb, alert && styles.thumbAlert)} aria-hidden={status === "error" ? undefined : true}>
      {src && status !== "error" && (
        // eslint-disable-next-line jsx-a11y/img-redundant-alt -- "Screenshot for …" is the meaningful label here.
        <img
          className={cx(styles.thumbImg, status === "ok" && styles.thumbImgLoaded)}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setStatus("ok")}
          onError={() => setStatus("error")}
        />
      )}
      {status === "loading" && <span className={styles.thumbShimmer} />}
      {status === "error" && (
        <span className={styles.thumbFallback} title="No screenshot for this capture">
          <Eye size={16} />
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  The rail                                                           *
 * ------------------------------------------------------------------ */

export function RunTimeline({
  rows,
  selectedIndex,
  onSelect,
  summary,
  error,
}: {
  rows: TimelineRow[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  summary: string;
  /** Replay error — surfaced as a one-line preview on the failing row. */
  error?: string | null;
}) {
  const reduce = useReducedMotion();
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const lastPos = rows.length - 1;

  function focusRow(index: number) {
    const el = rowRefs.current.get(index);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const order = rows.map((r) => r.index);
    const cur = order.indexOf(selectedIndex);
    if (cur === -1) return;
    let next = cur;
    if (e.key === "ArrowDown") next = Math.min(order.length - 1, cur + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = order.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(order[cur]);
      return;
    } else return;
    e.preventDefault();
    if (next !== cur) {
      onSelect(order[next]);
      focusRow(order[next]);
    }
  }

  return (
    <section className={styles.rail} aria-label="Run timeline">
      <header className={styles.railHeader}>
        <span className={styles.railTitle}>Run timeline</span>
        <span className={styles.summaryPill}>{summary}</span>
      </header>

      {/* biome-ignore lint/a11y/useSemanticElements: a roving-tabindex list is the right interaction model here. */}
      <div className={styles.rows} role="list" onKeyDown={onKeyDown}>
        {rows.map((row, pos) => {
          const isHero = row.kind === "checkpoint";
          const isNever = row.kind === "never";
          const isSelected = row.index === selectedIndex;
          const failing = row.kind !== "never" && row.failing;
          const node = isHero ? NODE.checkpoint : NODE.step;

          // Connector geometry: clip the line at the first/last node's centre.
          const lineStyle = {
            top: pos === 0 ? node.center : 0,
            bottom: pos === lastPos ? `calc(100% - ${node.center})` : 0,
          };

          // Node colour by state.
          let NodeIcon: IconType;
          const nodeStyle: Record<string, string> = {};
          if (failing) {
            NodeIcon = X;
            nodeStyle.background = "var(--color-danger)";
            nodeStyle.color = "#fff";
            nodeStyle.borderColor = "var(--color-danger)";
          } else if (isHero) {
            const badge = checkpointBadge(row.checkpoint);
            NodeIcon = badge.Icon;
            const tone = TONE_VARS[badge.tone];
            nodeStyle.background = tone.soft;
            nodeStyle.color = tone.fg;
            nodeStyle.borderColor = tone.soft;
          } else {
            NodeIcon = verbIcon(row.label);
          }

          const isNav = /^(navigate|goto|open)\b/i.test(row.label);
          const showDivider = isNav && pos > 0;

          const entrance = reduce
            ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
            : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } };

          return (
            <motion.div
              key={row.key}
              className={styles.rowWrap}
              {...entrance}
              transition={{ duration: 0.22, delay: Math.min(pos, 10) * 0.025, ease: "easeOut" }}
            >
              {showDivider && (
                <div className={styles.divider} aria-hidden>
                  <ExternalLink size={12} />
                  <span className={styles.dividerLabel}>{pageLabel(row.label)}</span>
                  <span className={styles.dividerRule} />
                </div>
              )}

              <div
                ref={(el) => {
                  if (el) rowRefs.current.set(row.index, el);
                  else rowRefs.current.delete(row.index);
                }}
                role="listitem"
                tabIndex={isSelected ? 0 : -1}
                aria-current={isSelected}
                aria-label={rowAriaLabel(row)}
                className={cx(styles.row, isHero ? styles.rowHero : styles.rowStep, isSelected && styles.rowSelected)}
                onClick={() => {
                  onSelect(row.index);
                  focusRow(row.index);
                }}
              >
                <div className={styles.gutter}>
                  <span className={styles.line} style={lineStyle} />
                  <span
                    className={cx(styles.node, isHero ? styles.nodeHero : styles.nodeStep, isNever && styles.nodeNever)}
                    style={nodeStyle}
                  >
                    <NodeIcon size={isHero ? 15 : 13} />
                  </span>
                </div>

                {isHero ? (
                  <HeroBody row={row} selected={isSelected} />
                ) : (
                  <StepBody
                    label={row.label}
                    failing={failing}
                    never={isNever}
                    durationMs={isNever ? null : row.durationMs}
                    errorPreview={failing ? error : null}
                  />
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 *  Row bodies                                                         *
 * ------------------------------------------------------------------ */

function HeroBody({
  row,
  selected,
}: {
  row: Extract<TimelineRow, { kind: "checkpoint" }>;
  selected: boolean;
}) {
  const cp = row.checkpoint;
  const badge = checkpointBadge(cp);
  const tone = TONE_VARS[badge.tone];
  const over = cp.diffScore != null && cp.diffScore > cp.threshold && needsDecision(cp);

  return (
    <div className={cx(styles.body, styles.heroBody, selected && styles.bodySelected)}>
      <Thumb src={cp.actualUrl} alt={`Screenshot for checkpoint “${cp.name}”`} alert={over} />
      <div className={styles.heroText}>
        <div className={styles.heroTitleRow}>
          <span className={styles.cpName} title={cp.name}>
            {cp.name}
          </span>
          <span className={styles.captureChip}>{CAPTURE_LABEL[cp.captureMode]}</span>
        </div>
        <div className={styles.heroMeta}>
          <span className={styles.stateBadge} style={{ background: tone.soft, color: tone.fg }}>
            <badge.Icon size={11} />
            {badge.label}
          </span>
          {cp.diffScore != null && <span className={styles.score}>{scorePct(cp.diffScore)}</span>}
          {cp.healed && <span className={styles.healed}>healed</span>}
        </div>
      </div>
      {!selected && (
        <span className={styles.open}>
          Open
          <ChevronDown size={13} className={styles.openChevron} />
        </span>
      )}
    </div>
  );
}

function StepBody({
  label,
  failing,
  never,
  durationMs,
  errorPreview,
}: {
  label: string;
  failing: boolean;
  never: boolean;
  durationMs: number | null;
  errorPreview?: string | null;
}) {
  return (
    <div className={cx(styles.body, styles.stepBody)}>
      <span className={cx(styles.stepLabel, failing && styles.stepLabelFailing, never && styles.stepLabelNever)} title={label}>
        {label}
      </span>
      {failing && errorPreview && (
        <span className={styles.errorPreview} title={errorPreview}>
          {errorPreview}
        </span>
      )}
      <span className={cx(styles.duration, failing && styles.durationFailing, never && styles.durationNever)}>
        {never ? "never ran" : durationMs != null ? duration(durationMs) : "—"}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function pageLabel(label: string): string {
  return label.replace(/^(navigate to|goto|open)\s*/i, "").replace(/["']/g, "");
}

function rowAriaLabel(row: TimelineRow): string {
  if (row.kind === "checkpoint") return `Checkpoint ${row.checkpoint.name}, ${checkpointBadge(row.checkpoint).label}`;
  if (row.kind === "never") return `${row.label}, never ran`;
  return `${row.label}${row.failing ? ", failed" : ""}`;
}
