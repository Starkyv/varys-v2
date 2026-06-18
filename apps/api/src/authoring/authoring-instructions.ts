import { readFileSync } from "node:fs";
import { Logger } from "@nestjs/common";

const log = new Logger("AuthoringInstructions");

/**
 * The "middleware prompt" — general authoring guidance surfaced to Claude through the MCP
 * `initialize` result's `instructions` field. MCP clients (Claude Code) fold this into the
 * model's context as server guidance before any tool call, so it steers HOW tests are
 * authored without being part of any single tool's schema.
 *
 * The baked-in defaults below ALWAYS apply (so the core rules — e.g. no network-idle waits
 * by default — hold even with zero configuration). Operator-supplied instructions are then
 * appended under their own heading, from either:
 *   - `VARYS_AUTHORING_INSTRUCTIONS`      — an inline string, or
 *   - `VARYS_AUTHORING_INSTRUCTIONS_FILE` — a path to a file (re-read on each connect, so
 *                                           you can edit it and reconnect without a restart).
 * The inline var wins when both are set.
 */
export const DEFAULT_AUTHORING_INSTRUCTIONS = `You are authoring a Varys visual-regression test by driving a real browser through the provided tools. The steps you record become a draft that a human reviews and promotes — keep it clean.

Core authoring rules:
- Keep tests minimal and deterministic. Record only the steps needed to reach and assert the thing under test; don't click around exploring once you know the path.
- Do NOT add networkIdle waits. Navigation already settles the page on network idle automatically at replay, so an explicit networkIdle wait is redundant noise in the test. Only add a wait when a SPECIFIC element is genuinely still loading — and when you do, prefer a 'selector' wait (wait for that element to become visible) over 'networkIdle' or a fixed 'delay'.
- Every test must assert something: add at least one checkpoint. Use 'fullpage' for "this whole screen renders", 'element' for a specific component.
- When the user asks you to "take a screenshot", "capture", "snapshot", or "check/verify this screen", that IS a checkpoint — call the checkpoint tool (it is the test's visual assertion). Do NOT satisfy such a request with observe(screenshot=true): that screenshot is only for your own perception and records nothing in the test.
- Give checkpoints stable, meaningful names — the name is part of the baseline key.
- Tokenize environment-specific or sensitive typed values ('variable' / 'secret') so the test stays portable across environments.`;

/** Operator-supplied instructions from env (inline wins over file); null when none set. */
function operatorInstructions(): string | null {
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

/** The full instructions string for the MCP `initialize` result — defaults plus any
 *  operator instructions. Resolved per connect so a file edit takes effect on reconnect. */
export function resolveAuthoringInstructions(): string {
  const op = operatorInstructions();
  return op
    ? `${DEFAULT_AUTHORING_INSTRUCTIONS}\n\n## Operator instructions\n\n${op}`
    : DEFAULT_AUTHORING_INSTRUCTIONS;
}
