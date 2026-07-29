import {
  appSettings,
  type Db,
  environments,
  runResults,
  runs,
  suiteRuns,
  tests,
  testVersions,
} from "@varys/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

/**
 * `@varys/notify` — Slack completion notifications for runs.
 *
 * The worker calls {@link notifyRunComplete} the moment a run finishes. A standalone run (manual
 * or scheduled) posts one message immediately; a suite-run child posts nothing on its own — instead
 * the LAST child to finish claims a one-shot fan-in flag (`suite_runs.notified_at`) and posts a
 * single suite summary, so a 20-test suite yields one Slack message, not twenty.
 *
 * When `attachPdf` is on AND the caller supplies a `renderPdf` (the worker wires it to Playwright's
 * `page.pdf()`), a rendered flow-report PDF is uploaded alongside the message.
 *
 * Config lives in `app_settings` (Configurations page), read fresh per notification so an edit
 * applies without a redeploy. Transport is the Slack Web API (`chat.postMessage` + the files v2
 * upload flow) with a bot token.
 */

/** `app_settings` keys for the Slack config. Mirrored by the API's settings service — keep in sync. */
export const SLACK_SETTINGS_KEYS = {
  token: "slack_bot_token",
  channel: "slack_channel",
  baseUrl: "slack_base_url",
  attachPdf: "slack_attach_pdf",
  notifyManual: "slack_notify_manual",
  notifySchedule: "slack_notify_schedule",
  notifySuite: "slack_notify_suite",
} as const;

/** The terminal run statuses — a run in one of these is done and eligible to notify / fan-in. */
const TERMINAL = ["passed", "needs_review", "failed", "cancelled"] as const;

export interface SlackConfig {
  token: string;
  channel: string;
  /** Base URL of the Varys web app for deep links; "" when unset (link omitted). */
  baseUrl: string;
  /** Attach a rendered PDF flow-report to each notification. */
  attachPdf: boolean;
  /** Per-source gates (each defaults ON). A notification is suppressed when its source's gate is off. */
  notifyManual: boolean;
  notifySchedule: boolean;
  notifySuite: boolean;
}

/** A message payload for `chat.postMessage` — `text` is the notification/fallback text; `blocks`
 *  is the rich layout. */
export interface SlackMessage {
  text: string;
  blocks: unknown[];
}

/** Renders report HTML to a PDF byte buffer. Injected by the worker (Playwright `page.pdf()`) so
 *  this package stays browser-free and unit-testable. */
export type RenderPdf = (html: string) => Promise<Buffer | Uint8Array>;

export interface NotifyOptions {
  renderPdf?: RenderPdf;
}

/**
 * Read the effective Slack config, or null when it can't/shouldn't notify: no bot token, no
 * channel, or ALL per-source gates muted (there's no separate master switch — all-off = off). The
 * worker treats null as "don't notify".
 */
export async function readSlackConfig(db: Db): Promise<SlackConfig | null> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, Object.values(SLACK_SETTINGS_KEYS)));
  const v = new Map(rows.map((r) => [r.key, r.value]));
  const token = (v.get(SLACK_SETTINGS_KEYS.token) ?? "").trim();
  const channel = (v.get(SLACK_SETTINGS_KEYS.channel) ?? "").trim();
  if (!token || !channel) return null;
  // Each per-source gate defaults ON — absent or "true" enables; only an explicit "false" mutes.
  const notifyManual = v.get(SLACK_SETTINGS_KEYS.notifyManual) !== "false";
  const notifySchedule = v.get(SLACK_SETTINGS_KEYS.notifySchedule) !== "false";
  const notifySuite = v.get(SLACK_SETTINGS_KEYS.notifySuite) !== "false";
  if (!notifyManual && !notifySchedule && !notifySuite) return null; // all sources muted → off
  return {
    token,
    channel,
    baseUrl: (v.get(SLACK_SETTINGS_KEYS.baseUrl) ?? "").trim(),
    attachPdf: v.get(SLACK_SETTINGS_KEYS.attachPdf) === "true",
    notifyManual,
    notifySchedule,
    notifySuite,
  };
}

/**
 * Post a message via `chat.postMessage`. Never throws — returns `{ ok, error?, channel?, ts? }`.
 * Slack answers 200 with `{ ok: false, error }` on logical failures (bad token, channel_not_found),
 * so we read the body, not just the HTTP status. `channel` is the RESOLVED channel id (even when a
 * `#name` was sent) — reused as the file upload's `channel_id`.
 */
export async function sendSlackMessage(
  config: SlackConfig,
  message: SlackMessage,
): Promise<{ ok: boolean; error?: string; channel?: string; ts?: string }> {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        channel: config.channel,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      channel?: string;
      ts?: string;
    };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    if (!body.ok) return { ok: false, error: body.error ?? "unknown_error" };
    return { ok: true, channel: body.channel, ts: body.ts };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Upload a file to a channel via Slack's files v2 flow: reserve an upload URL, PUT the bytes, then
 * complete (which posts it into `channelId`). Never throws. `channelId` must be a channel ID (not a
 * `#name`) — pass the id `chat.postMessage` returned.
 */
export async function uploadSlackFile(
  config: SlackConfig,
  file: { filename: string; title: string; bytes: Buffer | Uint8Array; channelId: string; initialComment?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const length = file.bytes.byteLength;
    // 1) Reserve an external upload URL.
    const reserveRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${config.token}`,
      },
      body: new URLSearchParams({ filename: file.filename, length: String(length) }),
    });
    const reserve = (await reserveRes.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      upload_url?: string;
      file_id?: string;
    };
    if (!reserve.ok || !reserve.upload_url || !reserve.file_id) {
      return { ok: false, error: reserve.error ?? "getUploadURLExternal_failed" };
    }
    // 2) POST the bytes to the reserved URL (multipart form field "file"). The cast sidesteps the
    // Buffer<ArrayBufferLike> vs BlobPart friction in newer TS libs — Blob accepts the view at runtime.
    const form = new FormData();
    form.append("file", new Blob([file.bytes as unknown as ArrayBuffer], { type: "application/pdf" }), file.filename);
    const putRes = await fetch(reserve.upload_url, { method: "POST", body: form });
    if (!putRes.ok) return { ok: false, error: `upload HTTP ${putRes.status}` };
    // 3) Complete — posts the file into the channel.
    const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        files: [{ id: reserve.file_id, title: file.title }],
        channel_id: file.channelId,
        ...(file.initialComment ? { initial_comment: file.initialComment } : {}),
      }),
    });
    const complete = (await completeRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!complete.ok) return { ok: false, error: complete.error ?? "completeUploadExternal_failed" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Emoji + human label for a coarse run/suite status. */
function statusFace(status: string): { emoji: string; label: string; tone: Tone } {
  switch (status) {
    case "passed":
      return { emoji: "✅", label: "PASSED", tone: "pass" };
    case "needs_review":
      return { emoji: "⚠️", label: "NEEDS REVIEW", tone: "review" };
    case "failed":
      return { emoji: "❌", label: "FAILED", tone: "fail" };
    case "cancelled":
      return { emoji: "🚫", label: "CANCELLED", tone: "neutral" };
    default:
      return { emoji: "•", label: status.toUpperCase(), tone: "neutral" };
  }
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/** Escape the few characters Slack mrkdwn treats specially in link/label text. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A `<url|label>` mrkdwn link, or just the label when no base URL is configured. */
function link(baseUrl: string, path: string, label: string): string {
  if (!baseUrl) return esc(label);
  const base = baseUrl.replace(/\/+$/, "");
  return `<${base}/${path}|${esc(label)}>`;
}

// ── Report model + PDF HTML ───────────────────────────────────────────────────────────────────

type Tone = "pass" | "fail" | "review" | "neutral";

interface ReportModel {
  title: string;
  subtitle: string;
  tiles: { label: string; value: string; tone?: Tone }[];
  rowsTitle: string;
  rows: { name: string; meta: string; status: string }[];
}

/** Reserved status palette — good/serious/warning + neutral. Paired with a glyph + label in the
 *  markup (never color-alone), per the visualization guidance. */
const TONE_CSS: Record<Tone, { fg: string; bg: string; glyph: string }> = {
  pass: { fg: "#1a7f37", bg: "#eaf6ec", glyph: "✓" },
  fail: { fg: "#cf222e", bg: "#fdeceb", glyph: "✕" },
  review: { fg: "#9a6700", bg: "#fdf3d7", glyph: "⚠" },
  neutral: { fg: "#57606a", bg: "#f0f2f5", glyph: "•" },
};

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A self-contained (inline-CSS) A4 flow-report — neutral tiles + a status-pilled table. */
function buildReportHtml(model: ReportModel): string {
  const tiles = model.tiles
    .map((t) => {
      const color = t.tone ? TONE_CSS[t.tone].fg : "#101322";
      return `<div class="tile"><div class="tileLabel">${htmlEscape(t.label)}</div><div class="tileValue" style="color:${color}">${htmlEscape(t.value)}</div></div>`;
    })
    .join("");
  const rows = model.rows
    .map((r) => {
      const f = statusFace(r.status);
      const c = TONE_CSS[f.tone];
      return `<tr>
        <td class="cName">${htmlEscape(r.name)}</td>
        <td class="cMeta">${htmlEscape(r.meta)}</td>
        <td class="cStatus"><span class="pill" style="color:${c.fg};background:${c.bg}">${c.glyph} ${htmlEscape(f.label)}</span></td>
      </tr>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #101322; padding: 40px; }
    h1 { font-size: 26px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }
    .sub { font-size: 13px; color: #6b7280; margin: 0 0 20px; }
    .rule { height: 1px; background: #e7eaef; margin: 0 0 24px; }
    .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 28px; }
    .tile { border: 1px solid #e7eaef; border-radius: 12px; padding: 14px 16px; background: #fbfcfd; }
    .tileLabel { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #8a909e; margin-bottom: 8px; }
    .tileValue { font-size: 20px; font-weight: 700; }
    .rowsTitle { font-size: 13px; font-weight: 600; color: #101322; margin: 0 0 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #8a909e; padding: 0 8px 8px; border-bottom: 1px solid #e7eaef; }
    td { padding: 9px 8px; border-bottom: 1px solid #f0f2f5; vertical-align: middle; }
    .cName { font-weight: 500; }
    .cMeta { color: #6b7280; }
    .cStatus { text-align: right; white-space: nowrap; }
    .pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  </style></head><body>
    <h1>${htmlEscape(model.title)}</h1>
    <p class="sub">${htmlEscape(model.subtitle)}</p>
    <div class="rule"></div>
    <div class="tiles">${tiles}</div>
    ${model.rows.length ? `<div class="rowsTitle">${htmlEscape(model.rowsTitle)}</div><table><thead><tr><th>Name</th><th>Detail</th><th style="text-align:right">Status</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
  </body></html>`;
}

function formatWhen(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function pct(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(2)}%`;
}

// ── Orchestration ─────────────────────────────────────────────────────────────────────────────

/**
 * Notify Slack that a run finished. Call once per run at terminal time (the worker's `finally`,
 * only when NOT cancelled). Standalone runs post immediately; a suite child triggers the fan-in
 * summary only when it's the last sibling to finish (claimed atomically). Best-effort: never
 * throws — a Slack/PDF failure is surfaced via the return value, never fails the run.
 */
export async function notifyRunComplete(
  db: Db,
  runId: string,
  opts: NotifyOptions = {},
): Promise<{ sent: boolean; error?: string }> {
  const cfg = await readSlackConfig(db);
  if (!cfg) return { sent: false };

  const [run] = await db
    .select({
      status: runs.status,
      error: runs.error,
      suiteRunId: runs.suiteRunId,
      environmentId: runs.environmentId,
      triggerSource: runs.triggerSource,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
      testName: tests.name,
    })
    .from(runs)
    .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
    .innerJoin(tests, eq(tests.id, testVersions.testId))
    .where(eq(runs.id, runId))
    .limit(1);
  if (!run) return { sent: false };

  if (run.suiteRunId) return notifySuiteIfComplete(db, cfg, run.suiteRunId, opts);

  // Per-source gate for a standalone run: a cron test-schedule is the "schedule" source, everything
  // else on-demand (Run button / API) is "manual". Muted → nothing posts.
  const isScheduled = run.triggerSource === "schedule";
  if (isScheduled ? !cfg.notifySchedule : !cfg.notifyManual) return { sent: false };

  const environment = await environmentName(db, run.environmentId);
  const checkpoints = await db
    .select({ name: runResults.checkpointName, reviewState: runResults.reviewState, diffScore: runResults.diffScore })
    .from(runResults)
    .where(eq(runResults.runId, runId));
  const passed = checkpoints.filter((c) => c.reviewState === "passed").length;
  const review = checkpoints.length - passed;
  const scores = checkpoints.map((c) => c.diffScore).filter((s): s is number => s != null);
  const avgMismatch = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const durationMs = (run.updatedAt ?? run.createdAt).getTime() - run.createdAt.getTime();
  const face = statusFace(run.status);

  const trigger = run.triggerSource === "schedule" ? " · scheduled" : "";
  const headline = `${face.emoji} ${esc(run.testName)} · ${esc(environment)} · ${face.label}${trigger}`;
  const detail =
    run.status === "failed" && run.error
      ? `Run failed: ${esc(run.error.slice(0, 300))}`
      : `${passed}/${checkpoints.length} checkpoint${checkpoints.length === 1 ? "" : "s"} passed` +
        (review > 0 ? ` · ${review} need review` : "") +
        ` · ${humanDuration(durationMs)}`;
  const viewRun = link(cfg.baseUrl, `?run=${encodeURIComponent(runId)}`, "View run");
  const message: SlackMessage = {
    text: `${face.emoji} ${run.testName} · ${environment} · ${face.label}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${headline}*` } },
      { type: "section", text: { type: "mrkdwn", text: `${detail}\n${viewRun}` } },
    ],
  };

  const report: ReportModel = {
    title: run.testName,
    subtitle: `Flow Report · ${environment} · ${formatWhen(run.createdAt)}`,
    tiles: [
      { label: "Status", value: face.label, tone: face.tone },
      { label: "Environment", value: environment },
      { label: "Duration", value: humanDuration(durationMs) },
      { label: "Checkpoints", value: String(checkpoints.length) },
      { label: "Passed", value: String(passed), tone: passed ? "pass" : "neutral" },
      { label: "Needs review", value: String(review), tone: review ? "review" : "neutral" },
      { label: "Avg mismatch", value: pct(avgMismatch) },
    ],
    rowsTitle: "Checkpoints",
    rows: checkpoints.map((c) => ({
      name: c.name,
      meta: c.diffScore != null ? `mismatch ${pct(c.diffScore)}` : "",
      status: c.reviewState === "passed" ? "passed" : "needs_review",
    })),
  };

  return postWithOptionalPdf(cfg, message, opts, {
    report,
    filename: `report-${slug(run.testName)}-${environment}.pdf`,
    title: `${run.testName} — flow report`,
  });
}

/** Fan-in: post the suite summary iff every child is terminal AND this call wins the one-shot
 *  claim on `suite_runs.notified_at`. */
async function notifySuiteIfComplete(
  db: Db,
  cfg: SlackConfig,
  suiteRunId: string,
  opts: NotifyOptions,
): Promise<{ sent: boolean; error?: string }> {
  if (!cfg.notifySuite) return { sent: false }; // suite notifications muted — skip (don't claim)
  const children = await db
    .select({
      status: runs.status,
      environmentId: runs.environmentId,
      testName: tests.name,
      runId: runs.id,
    })
    .from(runs)
    .innerJoin(testVersions, eq(testVersions.id, runs.testVersionId))
    .innerJoin(tests, eq(tests.id, testVersions.testId))
    .where(eq(runs.suiteRunId, suiteRunId));
  if (children.length === 0) return { sent: false };
  const allTerminal = children.every((c) => (TERMINAL as readonly string[]).includes(c.status));
  if (!allTerminal) return { sent: false };

  const claimed = await db
    .update(suiteRuns)
    .set({ notifiedAt: sql`now()` })
    .where(and(eq(suiteRuns.id, suiteRunId), isNull(suiteRuns.notifiedAt)))
    .returning({ id: suiteRuns.id });
  if (claimed.length === 0) return { sent: false };

  const [suite] = await db
    .select({ suiteName: suiteRuns.suiteName, createdAt: suiteRuns.createdAt })
    .from(suiteRuns)
    .where(eq(suiteRuns.id, suiteRunId))
    .limit(1);
  if (!suite) return { sent: false };

  const statuses = children.map((c) => c.status);
  const passed = statuses.filter((s) => s === "passed").length;
  const failed = statuses.filter((s) => s === "failed").length;
  const review = statuses.filter((s) => s === "needs_review").length;
  const envNamesByRun = await environmentNamesByRun(db, children);
  const envList = [...new Set(children.map((c) => envNamesByRun.get(c.runId) ?? "default"))].sort();
  const durationMs = Date.now() - suite.createdAt.getTime();
  const status = deriveSuiteStatus(statuses);
  const face = statusFace(status);

  // Avg mismatch across every child's checkpoints.
  const childIds = children.map((c) => c.runId);
  const scoreRows = childIds.length
    ? await db
        .select({ diffScore: runResults.diffScore })
        .from(runResults)
        .where(inArray(runResults.runId, childIds))
    : [];
  const scores = scoreRows.map((r) => r.diffScore).filter((s): s is number => s != null);
  const avgMismatch = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  const parts = [`${passed} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (review > 0) parts.push(`${review} need review`);
  const detail = `${parts.join(" · ")} · ${statuses.length} test${statuses.length === 1 ? "" : "s"} · ${humanDuration(durationMs)}`;
  const viewRun = link(
    cfg.baseUrl,
    `?view=suite-runs&suiteRun=${encodeURIComponent(suiteRunId)}`,
    "View suite run",
  );
  const message: SlackMessage = {
    text: `${face.emoji} ${suite.suiteName} · ${face.label}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${face.emoji} ${esc(suite.suiteName)} · ${esc(envList.join(", ") || "default")} · ${face.label}*` },
      },
      { type: "section", text: { type: "mrkdwn", text: `${detail}\n${viewRun}` } },
    ],
  };

  const report: ReportModel = {
    title: suite.suiteName,
    subtitle: `Suite Report · ${envList.join(", ") || "default"} · ${formatWhen(suite.createdAt)}`,
    tiles: [
      { label: "Status", value: face.label, tone: face.tone },
      { label: "Environments", value: envList.join(", ") || "default" },
      { label: "Duration", value: humanDuration(durationMs) },
      { label: "Tests", value: String(statuses.length) },
      { label: "Passed", value: String(passed), tone: passed ? "pass" : "neutral" },
      { label: "Failed", value: String(failed), tone: failed ? "fail" : "neutral" },
      { label: "Needs review", value: String(review), tone: review ? "review" : "neutral" },
      { label: "Avg mismatch", value: pct(avgMismatch) },
    ],
    rowsTitle: "Tests",
    rows: children.map((c) => ({
      name: c.testName,
      meta: envNamesByRun.get(c.runId) ?? "default",
      status: c.status,
    })),
  };

  return postWithOptionalPdf(cfg, message, opts, {
    report,
    filename: `report-${slug(suite.suiteName)}.pdf`,
    title: `${suite.suiteName} — suite report`,
  });
}

/** Post the message, then (when enabled + a renderer is available) render + upload the PDF into the
 *  resolved channel. A PDF failure never masks the (already-posted) message. */
async function postWithOptionalPdf(
  cfg: SlackConfig,
  message: SlackMessage,
  opts: NotifyOptions,
  pdf: { report: ReportModel; filename: string; title: string },
): Promise<{ sent: boolean; error?: string }> {
  const res = await sendSlackMessage(cfg, message);
  if (!res.ok) return { sent: false, error: res.error };

  if (cfg.attachPdf && opts.renderPdf && res.channel) {
    try {
      const bytes = await opts.renderPdf(buildReportHtml(pdf.report));
      const up = await uploadSlackFile(cfg, {
        filename: pdf.filename,
        title: pdf.title,
        bytes,
        channelId: res.channel,
      });
      if (!up.ok) return { sent: true, error: `message sent; PDF upload failed: ${up.error}` };
    } catch (err) {
      return { sent: true, error: `message sent; PDF render failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { sent: true };
}

/** Coarse suite status from child statuses: any queued/running → running; any failed → failed;
 *  any needs_review → needs_review; else passed (cancelled children don't drag the suite red). */
function deriveSuiteStatus(statuses: string[]): string {
  if (statuses.some((s) => s === "queued" || s === "running")) return "running";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "needs_review")) return "needs_review";
  return "passed";
}

/** A filesystem/URL-safe slug for a PDF filename. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "report"
  );
}

async function environmentName(db: Db, id: string | null): Promise<string> {
  if (!id) return "default";
  const [row] = await db
    .select({ name: environments.name })
    .from(environments)
    .where(eq(environments.id, id))
    .limit(1);
  return row?.name ?? "default";
}

/** Map each child run id → its environment name (default when env-less). */
async function environmentNamesByRun(
  db: Db,
  children: { runId: string; environmentId: string | null }[],
): Promise<Map<string, string>> {
  const ids = [...new Set(children.map((c) => c.environmentId).filter((x): x is string => !!x))];
  const byEnvId = new Map<string, string>();
  if (ids.length) {
    const rows = await db
      .select({ id: environments.id, name: environments.name })
      .from(environments)
      .where(inArray(environments.id, ids));
    for (const r of rows) byEnvId.set(r.id, r.name);
  }
  return new Map(children.map((c) => [c.runId, c.environmentId ? (byEnvId.get(c.environmentId) ?? "default") : "default"]));
}
