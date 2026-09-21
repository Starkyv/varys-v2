#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import type { BridgeCommand } from "@varys/review-contract";
import { runClaude } from "./claude";
import { pair, postEvents, readCommands } from "./relay";

/**
 * `varys-connect` — the **Bridge Helper**.
 *
 * One process, run by the user on their own machine, that turns a press of **Run** in Varys into
 * their own Claude walking an **Agent-Driven Test**. It is the missing half of a feature whose
 * whole premise is that Varys drives no browser and pays for no model: Varys asks, this listens,
 * and the user's own Claude Code subscription does the work.
 *
 * What it does NOT do is as load-bearing as what it does:
 *
 *  - It never creates a Run. Only `start_agent_run`, called by the spawned Claude over MCP as the
 *    signed-in user, does that — which is why Varys can believe the resulting Run came from the
 *    web app. A helper that could report a Run into existence would make that marker worthless.
 *  - It holds no Anthropic API key and no Varys session cookie. Its one credential is a bridge
 *    token scoped to a single chat, good for exactly two things: reading commands and mirroring
 *    events back.
 *  - It reads the test id off the command and passes that id through verbatim. It never searches
 *    for a test by name, because "the wrong test ran" is the failure the id exists to prevent.
 *
 * Usage:
 *   npx @varys/connect <pairing-code>
 *   VARYS_API=https://varys.example.com npx @varys/connect <pairing-code>
 */

const API = (process.env.VARYS_API ?? "http://localhost:4000").replace(/\/+$/, "");
/**
 * How the spawned Claude answers its own permission prompts.
 *
 * `bypassPermissions` by default, and that is a real choice worth understanding rather than a
 * default nobody picked: nothing is watching that process's stdin, so any mode that stops to ask
 * is a mode that hangs until the Wall-Clock Lease runs out and the run goes red for a reason that
 * has nothing to do with the application. Walking a journey means driving a browser, and the
 * tooling that does it is not knowable in advance.
 *
 * Set `VARYS_CONNECT_PERMISSION_MODE=acceptEdits` (or `manual`, `plan`, …) to tighten it, knowing
 * that a prompt nobody answers is a session that stalls.
 */
const PERMISSION_MODE = process.env.VARYS_CONNECT_PERMISSION_MODE ?? "bypassPermissions";
/** Where the spawned Claude runs — its CLAUDE.md, its MCP servers, its files. */
const CWD = process.env.VARYS_CONNECT_CWD ?? process.cwd();
/** How long to wait before re-opening a dropped command stream, and the ceiling it backs off to. */
const RECONNECT_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * What the spawned Claude is told when Varys asks for a run.
 *
 * It names the test by **id** and tells Claude to call the tool with that id — no searching, no
 * paraphrase. Everything else the run needs (the AI Instructions, the Checkpoint Manifest, the
 * baselines) comes back from `start_agent_run` itself, so none of it is restated here: a second
 * copy in this prompt is a second copy that can disagree with the authoritative one.
 *
 * The honesty of the run is restated, because it is the part an eager agent gets wrong: the run
 * is created already failed, the Manifest is closed, and an unreachable state is a finding rather
 * than something to work around.
 */
function runPrompt(testId: string, environmentId: string | null): string {
  const env = environmentId
    ? `\n  environmentId: "${environmentId}"`
    : "\n  (no environmentId — this test runs against no environment)";
  return [
    "Varys has asked you to run one Agent-Driven Test on this machine. Do only this.",
    "",
    "Call the `start_agent_run` tool on the `varys` MCP server with:",
    `  testId: "${testId}"${env}`,
    "",
    "Use that testId exactly as written. Do not look the test up by name, and do not run any",
    "other test — the id is how Varys guarantees the test you were asked for is the test that",
    "runs.",
    "",
    "It returns the AI Instructions, the ordered Checkpoint Manifest and the approved baselines.",
    "Follow the instructions as written, drive the app with whatever browser tooling you have,",
    "and report each state with `submit_checkpoint` — the Manifest is a closed set, so do not",
    "invent, rename, merge or skip a slot. Call `finish_agent_run` when you are done.",
    "",
    "The run is created ALREADY FAILED, with reason `unreached`. Every slot you fill is what",
    "changes that, and anything you do not report counts as not verified. If a state cannot be",
    "reached, say so and leave it red — the honest red is the finding, not a problem to route",
    "around. You are working against a server-side wall-clock lease that nothing here can extend.",
  ].join("\n");
}

/** A Claude session per chat, so the authoring conversation is a conversation and not a series of
 *  strangers. Run requests deliberately start fresh — a run is not a chat turn. */
let chatSession: string | null = null;

async function handlePrompt(token: string, text: string): Promise<void> {
  console.log(`prompt: ${text}`);
  try {
    const { sessionId } = await runClaude({
      prompt: text,
      resume: chatSession,
      permissionMode: PERMISSION_MODE,
      cwd: CWD,
      onEvent: (e) => {
        if (e.kind === "assistant") void postEvents(API, token, [{ type: "assistant", text: e.text }]);
        else if (e.kind === "tool")
          void postEvents(API, token, [{ type: "tool", name: e.name, detail: e.detail }]);
      },
    });
    if (sessionId) chatSession = sessionId;
  } catch (e) {
    await reportLaunchFailure(token, e);
  }
}

/**
 * Claude could not be started at all — the one failure worth saying twice.
 *
 * It goes to this terminal AND into the web app, because the two audiences need different things
 * from it: whoever is at this machine can fix it, and whoever pressed the button is otherwise left
 * watching a request lapse with no way to tell "nothing was listening" from "your helper answered
 * and then could not start Claude". Those have completely different remedies.
 */
async function reportLaunchFailure(token: string, e: unknown): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`  ! ${message}`);
  await postEvents(API, token, [
    { type: "assistant", text: `Could not start Claude: ${message}` },
  ]);
}

/**
 * A run request: acknowledge first, then launch.
 *
 * The order matters and is the whole reason `acknowledged` is a distinct phase. Acknowledging
 * says "the command reached a helper that is alive", which is a fact this process knows before it
 * knows anything about Claude. Sending it after the launch would fold two different failures —
 * the command never arrived, and Claude could not be started — into one silence, and telling
 * those apart is exactly what the author needs in order to know whether pressing again will help.
 */
async function handleRunRequest(token: string, cmd: Extract<BridgeCommand, { type: "run-agent-test" }>) {
  console.log(`run requested: test ${cmd.testId}${cmd.environmentId ? ` · env ${cmd.environmentId}` : ""}`);
  await postEvents(API, token, [{ type: "agent-run-launched", testId: cmd.testId }]);

  try {
    await runClaude({
      prompt: runPrompt(cmd.testId, cmd.environmentId),
      // Never resumed: a run is its own session, and inheriting the authoring chat's context
      // would hand the agent a transcript that has nothing to do with the journey it must walk.
      resume: null,
      permissionMode: PERMISSION_MODE,
      cwd: CWD,
      onEvent: (e) => {
        if (e.kind === "tool") {
          console.log(`  · ${e.name}${e.detail ? ` — ${e.detail}` : ""}`);
          void postEvents(API, token, [{ type: "tool", name: e.name, detail: e.detail }]);
        } else if (e.kind === "assistant") {
          void postEvents(API, token, [{ type: "assistant", text: e.text }]);
        } else if (e.kind === "done") {
          console.log(e.ok ? "  ✓ session finished" : "  ✗ session ended without finishing");
        }
      },
    });
  } catch (e) {
    // The request will lapse in a minute or two regardless; what this buys the author is knowing
    // WHY, which decides whether pressing again is worth anything.
    await reportLaunchFailure(token, e);
  }
}

async function readCode(): Promise<string> {
  const fromArgv = process.argv[2]?.trim();
  if (fromArgv) return fromArgv;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("Pairing code from Varys: ")).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const code = await readCode();
  if (!code) {
    console.error("usage: varys-connect <pairing-code>");
    process.exit(1);
  }

  const { chatId, bridgeToken } = await pair(API, code);
  console.log(`paired with ${API} → chat ${chatId}`);
  console.log(
    `launching Claude in ${CWD} with --permission-mode ${PERMISSION_MODE}` +
      (PERMISSION_MODE === "bypassPermissions"
        ? " (nothing is watching its prompts; set VARYS_CONNECT_PERMISSION_MODE to change this)"
        : ""),
  );
  console.log("connected — press Run on an Agent-Driven Test in Varys. Ctrl-C to stop.");

  // Reconnect on a dropped stream, because the alternative is a helper that is running, looks
  // fine in this terminal, and has been invisible to the Run button since the last hiccup.
  let backoff = RECONNECT_MS;
  for (;;) {
    const openedAt = Date.now();
    const { reason } = await readCommands(API, bridgeToken, (cmd) => {
      if (cmd.type === "prompt") void handlePrompt(bridgeToken, cmd.text);
      else if (cmd.type === "run-agent-test") void handleRunRequest(bridgeToken, cmd);
    });
    // A stream that stayed up is evidence the relay is healthy, so the next hiccup starts from
    // the short delay again. Without this, one bad afternoon leaves the helper checking in every
    // thirty seconds for the rest of the day.
    if (Date.now() - openedAt > RECONNECT_MAX_MS) backoff = RECONNECT_MS;
    if (reason === "unauthorized") {
      console.error("Varys no longer recognises this helper — re-pair for a fresh code.");
      process.exit(1);
    }
    console.error(`stream ${reason}; reconnecting in ${Math.round(backoff / 1000)}s…`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
