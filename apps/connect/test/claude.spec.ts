import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ClaudeEvent, runClaude } from "../src/claude";

/**
 * The helper's one piece of real logic: turning `claude --output-format stream-json` into the
 * events the Varys chat mirrors.
 *
 * Driven against a stub `claude` on PATH rather than the real CLI — the thing under test is the
 * parse, and a test that spent somebody's Claude subscription to assert it would be a test nobody
 * runs. Everything else in this program is HTTP the relay's own E2E suite already covers from the
 * other side.
 */
describe("reading a Claude session", () => {
  const withStub = { ...process.env, PATH: `${join(__dirname, "fixtures")}:${process.env.PATH}` };

  async function collect(prompt: string): Promise<{ events: ClaudeEvent[]; sessionId: string | null }> {
    const events: ClaudeEvent[] = [];
    const saved = process.env.PATH;
    process.env.PATH = withStub.PATH;
    try {
      const { sessionId } = await runClaude({
        prompt,
        resume: null,
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
        onEvent: (e) => events.push(e),
      });
      return { events, sessionId };
    } finally {
      process.env.PATH = saved;
    }
  }

  it("reports the session, the prose and each tool call, and says when the turn ended", async () => {
    const { events, sessionId } = await collect("run the checkout test");

    // The session id is what makes the next chat turn a continuation rather than a stranger.
    expect(sessionId).toBe("sess-abc");
    expect(events).toContainEqual({ kind: "session", sessionId: "sess-abc" });
    expect(events).toContainEqual({ kind: "assistant", text: "Starting the run." });
    // A tool chip names the tool and one identifying argument — here the test id, which is the
    // only thing a reader watching a run actually wants to confirm.
    expect(events).toContainEqual({
      kind: "tool",
      name: "mcp__varys__start_agent_run",
      detail: "T-1",
    });
    // Tool RESULTS are deliberately not mirrored: they are the agent's raw working, and the chat
    // is a place to follow along, not a transcript.
    expect(events.filter((e) => e.kind === "tool")).toHaveLength(1);

    const done = events.find((e) => e.kind === "done");
    expect(done).toEqual({ kind: "done", ok: true, summary: "done" });
    // The prompt really did reach the process, rather than the stub answering from nothing.
    expect(events).toContainEqual({ kind: "assistant", text: "Saw prompt: run the checkout tes" });
  });

  it("fails loudly when `claude` is not installed, rather than looking like a quiet session", async () => {
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await expect(
        runClaude({
          prompt: "anything",
          resume: null,
          permissionMode: "bypassPermissions",
          cwd: process.cwd(),
          onEvent: () => undefined,
        }),
      ).rejects.toThrow(/could not start `claude`/);
    } finally {
      process.env.PATH = saved;
    }
  });
});
