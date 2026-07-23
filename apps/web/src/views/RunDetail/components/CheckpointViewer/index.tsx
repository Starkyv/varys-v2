import type { CaptureMode, CheckpointView, FingerprintSummary } from "@varys/review-contract";
import {
  Badge,
  Columns,
  cx,
  Layers,
  OnionSkin,
  SegmentedControl,
  type SegmentedOption,
  Sliders,
  SwipeView,
} from "@varys/ui";
import { useState } from "react";
import { scorePct } from "../../../../lib/format";
import { DecisionBar } from "../DecisionBar";
import { DiffStage, type DiffMode } from "../DiffStage";
import { LocatorDetail } from "../LocatorDetail";
import { MaskTuning } from "../MaskTuning";
import { PendingMaskEditor } from "../PendingMaskEditor";
import styles from "./styles.module.scss";

const CAPTURE_LABEL: Record<CaptureMode, string> = {
  element: "Element",
  fullpage: "Full page",
  region: "Region",
};

export function CheckpointViewer({
  checkpoint: cp,
  runId,
  target,
  gallery,
}: {
  checkpoint: CheckpointView;
  runId: string;
  /** The recorded element fingerprint this checkpoint's screenshot was located by. */
  target?: FingerprintSummary | null;
  /** Run-wide ordered images, so the lightbox can step across every checkpoint. */
  gallery?: { src: string; label: string }[];
}) {
  const [mode, setMode] = useState<DiffMode>("side-by-side");
  const [swipe, setSwipe] = useState(50);
  const [onion, setOnion] = useState(50);
  // A passing checkpoint has no diff, so the mask editor lives behind a toggle (kept available so
  // masks stay editable after they've resolved the diff). A failing one shows it expanded inline.
  const [showMaskEditor, setShowMaskEditor] = useState(false);

  const isPending = cp.reviewState === "pending-baseline";
  const hasBaseline = !isPending && cp.baselineUrl != null;
  const over = cp.diffScore != null && cp.diffScore > cp.threshold;
  // Context checkpoints are judged by an LLM, not pixel-diffed: "failing" is a `diff` reviewState,
  // and the pixel-only knobs (threshold, mask editors, diff-highlight) don't apply.
  const isContext = cp.compareMode === "context";
  const failing = isContext ? cp.reviewState === "diff" : over;

  const modeOptions: SegmentedOption<DiffMode>[] = [
    { value: "side-by-side", label: "Side by side", icon: <Columns size={14} /> },
    ...(cp.diffUrl ? [{ value: "diff-highlight" as const, label: "Highlight", icon: <Layers size={14} /> }] : []),
    ...(hasBaseline
      ? [
          { value: "swipe" as const, label: "Swipe", icon: <SwipeView size={14} /> },
          { value: "onion" as const, label: "Onion", icon: <OnionSkin size={14} /> },
        ]
      : []),
  ];

  return (
    <div className={styles.card}>
      <header className={styles.header}>
        <div className={styles.name}>{cp.name}</div>
        <span className={styles.capture}>{CAPTURE_LABEL[cp.captureMode]}</span>
        {cp.healed && (
          <Badge tone="info" size="sm">
            healed
          </Badge>
        )}
        <span className={styles.spacer} />
        {!isPending && modeOptions.length > 1 && (
          <SegmentedControl ariaLabel="Diff view mode" options={modeOptions} value={mode} onValueChange={setMode} />
        )}
      </header>

      <DiffStage checkpoint={cp} mode={mode} swipe={swipe} onion={onion} gallery={gallery} />

      {mode === "swipe" && hasBaseline && (
        <div className={styles.sliderRow}>
          <span className={styles.sliderEnd}>Baseline</span>
          <input type="range" min={0} max={100} value={swipe} onChange={(e) => setSwipe(Number(e.target.value))} className={styles.slider} />
          <span className={styles.sliderEnd}>Actual</span>
        </div>
      )}
      {mode === "onion" && hasBaseline && (
        <div className={styles.sliderRow}>
          <span className={styles.sliderEnd}>Opacity</span>
          <input type="range" min={0} max={100} value={onion} onChange={(e) => setOnion(Number(e.target.value))} className={styles.slider} />
          <span className={cx(styles.sliderEnd, styles.mono)}>{onion}%</span>
        </div>
      )}

      <div className={styles.review}>
        <div
          className={cx(styles.verdict, isPending ? styles.verdictInfo : failing ? styles.verdictDanger : styles.verdictSuccess)}
        >
          <span className={styles.verdictLabel}>
            {isPending
              ? "First capture — no baseline yet"
              : isContext
                ? failing
                  ? "AI judge: fail"
                  : "AI judge: pass"
                : over
                  ? "Over threshold"
                  : "Within threshold"}
          </span>
          {!isPending && !isContext && (
            <span className={styles.verdictScore}>
              Diff <strong className={styles.mono}>{scorePct(cp.diffScore)}</strong> · threshold{" "}
              <strong className={styles.mono}>{scorePct(cp.threshold, 2)}</strong>
            </span>
          )}
          {!isPending && isContext && cp.judgeReasoning && (
            <span className={styles.verdictScore}>{cp.judgeReasoning}</span>
          )}
        </div>

        {isPending && !isContext && (
          // First capture — no baseline to diff yet, so edit the ignore regions directly on the
          // capture that's about to become the baseline (draw / move / resize; saves a version).
          <PendingMaskEditor checkpoint={cp} runId={runId} />
        )}

        {hasBaseline &&
          !isContext &&
          (cp.diffUrl ? (
            // Failing / over threshold — the editor is part of the review, shown inline.
            <MaskTuning checkpoint={cp} runId={runId} />
          ) : (
            // Passing — masks stay editable, but behind a toggle so the clean view stays clean.
            <div className={styles.maskEdit}>
              <button
                type="button"
                className={styles.maskEditToggle}
                aria-expanded={showMaskEditor}
                onClick={() => setShowMaskEditor((v) => !v)}
              >
                <Sliders size={14} />
                {showMaskEditor
                  ? "Hide mask editor"
                  : cp.masks.length > 0
                    ? `Edit masks · ${cp.masks.length} set`
                    : "Add masks"}
              </button>
              {showMaskEditor && <MaskTuning checkpoint={cp} runId={runId} />}
            </div>
          ))}

        <DecisionBar checkpoint={cp} runId={runId} />

        {target && <LocatorDetail target={target} />}
      </div>
    </div>
  );
}
