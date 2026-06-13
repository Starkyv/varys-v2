import {
  Badge,
  Check,
  Clock,
  Dash,
  Eye,
  Layers,
  Spinner,
  X,
  type Intent,
} from "@varys/ui";
import type { ReactNode } from "react";

/**
 * The Varys status vocabulary → visual mapping. One source of truth for every run
 * status (`queued | running | passed | needs_review | failed`), checkpoint review
 * state (`pending-baseline | diff | passed`), and the derived suite-run / matrix
 * statuses — so a status looks identical in the dashboard, the runs table, the
 * review queue and the diff viewer.
 */
export type StatusKey =
  | "passed"
  | "needs_review"
  | "diff"
  | "pending-baseline"
  | "failed"
  | "queued"
  | "running"
  | "none";

interface StatusMeta {
  tone: Intent;
  label: string;
}

const META: Record<StatusKey, StatusMeta> = {
  passed: { tone: "success", label: "Passed" },
  needs_review: { tone: "warning", label: "Needs review" },
  diff: { tone: "warning", label: "Diff" },
  "pending-baseline": { tone: "info", label: "Pending baseline" },
  failed: { tone: "danger", label: "Failed" },
  queued: { tone: "neutral", label: "Queued" },
  running: { tone: "neutral", label: "Running" },
  none: { tone: "neutral", label: "No runs" },
};

function key(status: string): StatusKey {
  return (status in META ? status : "none") as StatusKey;
}

export function statusTone(status: string): Intent {
  return META[key(status)].tone;
}

export function statusLabel(status: string): string {
  return META[key(status)].label;
}

/** The status glyph, rendered fresh (so the same status can appear many times). */
export function StatusIcon({ status, size = "1em" }: { status: string; size?: number | string }) {
  switch (key(status)) {
    case "passed":
      return <Check size={size} />;
    case "needs_review":
    case "diff":
      return <Eye size={size} />;
    case "pending-baseline":
      return <Layers size={size} />;
    case "failed":
      return <X size={size} />;
    case "queued":
      return <Clock size={size} />;
    case "running":
      return <Spinner size={size} />;
    default:
      return <Dash size={size} />;
  }
}

/** A status pill — glyph + label, toned via the shared Badge. */
export function StatusBadge({
  status,
  size = "sm",
  label,
}: {
  status: string;
  size?: "sm" | "md";
  /** Override the default label text. */
  label?: ReactNode;
}) {
  return (
    <Badge tone={statusTone(status)} size={size} icon={<StatusIcon status={status} />}>
      {label ?? statusLabel(status)}
    </Badge>
  );
}

/** Raw token strings per intent — for custom surfaces (matrix cells, feed dots,
 *  suite-run stacked bars, sparklines) that aren't a Badge. */
export const TONE_VARS: Record<Intent, { base: string; soft: string; fg: string }> = {
  primary: { base: "var(--color-primary)", soft: "var(--color-primary-soft)", fg: "var(--color-primary)" },
  neutral: { base: "var(--color-neutral-500)", soft: "var(--color-neutral-100)", fg: "var(--color-neutral-700)" },
  success: { base: "var(--color-success)", soft: "var(--color-success-soft)", fg: "var(--color-success-fg)" },
  warning: { base: "var(--color-warning)", soft: "var(--color-warning-soft)", fg: "var(--color-warning-fg)" },
  danger: { base: "var(--color-danger)", soft: "var(--color-danger-soft)", fg: "var(--color-danger-fg)" },
  info: { base: "var(--color-info)", soft: "var(--color-info-soft)", fg: "var(--color-info-fg)" },
};

export function statusVars(status: string) {
  return TONE_VARS[statusTone(status)];
}
