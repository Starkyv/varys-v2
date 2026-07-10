import { readFileSync } from "node:fs";
import { Logger } from "@nestjs/common";

const log = new Logger("AuthoringInstructions");

/**
 * The "middleware prompt" — general authoring guidance surfaced to Claude through the MCP
 * `initialize` result's `instructions` field. MCP clients (Claude Code) fold this into the
 * model's context as server guidance before any tool call, so it steers HOW tests are
 * authored without being part of any single tool's schema.
 *
 * The baked-in default below is the SEED + reset target for the editable base prompt. At runtime
 * `AuthoringInstructionsService` serves the base prompt from the DB (edited on the Author page),
 * falling back to this default when nothing is saved — so the team can change the instructions
 * without a redeploy. An optional env overlay (`VARYS_AUTHORING_INSTRUCTIONS` inline, or
 * `VARYS_AUTHORING_INSTRUCTIONS_FILE`, inline wins) is appended ON TOP as a deployment-level lock.
 */
export const DEFAULT_AUTHORING_INSTRUCTIONS = `You are authoring a Varys visual-regression test by driving a real browser through the provided tools. The steps you record become a draft that a human reviews and promotes — keep it clean.

Two ways you'll be asked to author — \`mode\` is REQUIRED on open_session; you must pass it and must never default silently. Decide the mode by this rule: use "batch" ONLY when the user explicitly says "batch" or points you at a plan / instructions file to run end-to-end; use "interactive" when the user is directing you one step at a time. If it is genuinely unclear which the user wants, ASK before opening the session — do not guess.
- Step-by-step (mode "interactive", the default): the user gives one instruction at a time. Perform exactly that one action, then stop and report what you did and what the page now shows. Don't run ahead to later steps. NEVER end the session on your own — it ends ONLY when the user explicitly tells you to finish or save it (e.g. "finish the session", "we're done", "save it"). When they do, call finish_session with confirm: true; the server refuses finish_session on an interactive session without that confirmation.
- Batch (mode "batch"): the user said "batch" or pointed you at a plan / instructions file. Read the file, open_session with mode "batch", then execute every step to completion without pausing for confirmation between steps, and call finish_session at the end (no confirm needed in batch). open_session returns mode-specific \`guidance\`; follow it.

Core authoring rules:
- Keep tests minimal and deterministic. Record only the steps needed to reach and assert the thing under test; don't click around exploring once you know the path.
- Do NOT add networkIdle waits. Navigation already settles the page on network idle automatically at replay, so an explicit networkIdle wait is redundant noise in the test. Only add a wait when a SPECIFIC element is genuinely still loading — and when you do, prefer a 'selector' wait (wait for that element to become visible) over 'networkIdle' or a fixed 'delay'.
- Checkpoints are the test's only visual assertions, and you take one ONLY when the instruction explicitly asks for it — "take a screenshot", "capture", "snapshot", "checkpoint", or "check/verify this screen". Do NOT add a checkpoint on your own initiative: not after every step, not to "make the test assert something", not because a screen looks important. If the user/plan never asks for one, finish with zero checkpoints — finish_session will note the draft asserts nothing, which is fine; a human can add one in review. Never invent a checkpoint just to avoid that warning.
- When you ARE asked for a checkpoint, call the checkpoint tool (use 'fullpage' for "this whole screen renders", 'element' for a specific component). Never satisfy a screenshot/capture request with observe(screenshot=true): that screenshot is for YOUR perception only and records nothing in the test.
- Give checkpoints stable, meaningful names — the name is part of the baseline key.
- Tokenize environment-specific or sensitive typed values ('variable' / 'secret') so the test stays portable across environments.`;

/**
 * Operator-supplied instructions from env (inline wins over file); null when none set.
 * This is a DEPLOYMENT-LEVEL overlay: when set, `AuthoringInstructionsService` appends it on
 * top of the (now UI-editable) base prompt and the Author page treats it as read-only — so an
 * operator can lock guidance via env that the web editor can't override. Normally unset, in
 * which case the editable base prompt (DB, or this default) is served as-is.
 */
export function envOperatorInstructions(): string | null {
  const inline = process.env.VARYS_AUTHORING_INSTRUCTIONS?.trim();
  if (inline) return inline;

  const file = process.env.VARYS_AUTHORING_INSTRUCTIONS_FILE?.trim();
  if (file) {
    try {
      const text = readFileSync(file, "utf8").trim();
      if (text) return text;
    } catch (err) {
      log.warn(`could not read VARYS_AUTHORING_INSTRUCTIONS_FILE (${file}): ${(err as Error).message}`);
    }
  }
  return null;
}
