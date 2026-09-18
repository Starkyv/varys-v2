import { spawn } from "node:child_process";

/**
 * Launching the user's own Claude.
 *
 * The entire point of the Bridge Helper is that **Varys holds no credential that can summon a
 * model**. So this spawns the `claude` CLI already installed and signed in on this machine, and
 * the work is billed to that subscription. There is no Anthropic API key here, no place to put
 * one, and nothing is sent to Varys but the events below.
 *
 * Varys is reached by the spawned Claude over MCP, as the signed-in user — NOT by this process.
 * The bridge token this helper holds is a relay credential, scoped to one chat; it cannot create
 * a Run and must not be able to. That separation is what makes the trigger marker trustworthy:
 * only a real `start_agent_run` from the user's own OAuth principal produces a Run, so nothing
 * here can fake one.
 */

/** One parsed line of `--output-format stream-json`, reduced to what the relay mirrors. */
export type ClaudeEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "done"; ok: boolean; summary: string };

export interface RunClaudeOptions {
  prompt: string;
  /** Resume this Claude session instead of starting a fresh one — what makes the chat a chat. */
  resume?: string | null;
  /** How the spawned Claude answers its own permission prompts. Nobody is watching its stdin, so
   *  a mode that stops to ask is a mode that hangs forever. See the README. */
  permissionMode: string;
  /** Working directory the agent runs in — its files, its CLAUDE.md, its MCP config. */
  cwd: string;
  onEvent: (e: ClaudeEvent) => void;
}

/** Text of an assistant message, flattened; tool calls are reported separately. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => {
      const t = b as { type?: string; text?: unknown };
      return t?.type === "text" && typeof t.text === "string";
    })
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** A one-line gist of a tool's input, for the chip the web chat shows. Truncated hard: this is a
 *  label beside a tool name, not a transcript. */
function detailOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ["testId", "url", "name", "selector", "text", "command"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.length > 120 ? `${v.slice(0, 117)}…` : v;
  }
  const keys = Object.keys(obj);
  return keys.length ? keys.join(", ") : undefined;
}

/**
 * Run one Claude turn to completion, reporting events as they arrive.
 *
 * Resolves with the session id (so the next turn can resume it) whether the turn succeeded or
 * failed — a failed turn is still a turn the user asked for, and losing the thread would make the
 * next prompt start from nothing. Rejects only when `claude` could not be started at all, which
 * is the one case the user must fix before anything else can work.
 */
export function runClaude(opts: RunClaudeOptions): Promise<{ sessionId: string | null }> {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    // stream-json is refused without it; the extra chatter is parsed, not printed.
    "--verbose",
    "--permission-mode",
    opts.permissionMode,
  ];
  if (opts.resume) args.push("--resume", opts.resume);
  args.push(opts.prompt);

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      // stdin closed: nothing will type an answer to a prompt, and leaving it open makes a
      // blocked agent look like a working one.
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let sessionId: string | null = null;
    let buf = "";
    let stderr = "";

    child.on("error", (e) => {
      reject(
        new Error(
          `could not start \`claude\` (${e.message}). Install Claude Code and sign in, then try again.`,
        ),
      );
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      // biome-ignore lint: assignment-in-condition is the idiomatic line splitter here.
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // a non-JSON line is Claude's own chatter, not an event.
        }
        const type = msg.type;
        if (type === "system" && typeof msg.session_id === "string") {
          sessionId = msg.session_id;
          opts.onEvent({ kind: "session", sessionId });
          continue;
        }
        if (type === "assistant") {
          const content = (msg.message as { content?: unknown } | undefined)?.content;
          const text = textOf(content);
          if (text) opts.onEvent({ kind: "assistant", text });
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as { type?: string; name?: string; input?: unknown };
              if (b?.type === "tool_use" && typeof b.name === "string") {
                opts.onEvent({ kind: "tool", name: b.name, detail: detailOf(b.input) });
              }
            }
          }
          continue;
        }
        if (type === "result") {
          const ok = msg.subtype === "success" && msg.is_error !== true;
          const summary = typeof msg.result === "string" ? msg.result : "";
          opts.onEvent({ kind: "done", ok, summary });
        }
      }
    });

    child.on("close", (code) => {
      if (code !== 0 && stderr.trim()) {
        opts.onEvent({ kind: "assistant", text: `Claude exited (${code}): ${stderr.trim().slice(0, 500)}` });
      }
      resolve({ sessionId });
    });
  });
}
