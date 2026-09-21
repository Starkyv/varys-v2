import type { BridgeCommand, BridgeHelperEvent, BridgePairResult } from "@varys/review-contract";

/**
 * The relay half of the helper: claim a pairing code, hold the downward command stream open, and
 * post events back up.
 *
 * Deliberately dependency-free — `fetch` and a hand-rolled SSE reader. A helper the user runs on
 * their own machine should be something they can read in one sitting and trust; a transitive tree
 * of HTTP clients is not that.
 */

/** Claim a one-time pairing code → a chat-scoped bridge token. */
export async function pair(api: string, code: string): Promise<BridgePairResult> {
  const res = await fetch(`${api}/authoring/bridge/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "that pairing code is invalid or has expired — press “Pair a helper” in Varys for a fresh one"
        : `pairing failed (${res.status})`,
    );
  }
  return (await res.json()) as BridgePairResult;
}

/** Mirror events up into the web chat. Failures are reported, never thrown: losing a status line
 *  must not take down a session that is otherwise working. */
export async function postEvents(
  api: string,
  token: string,
  events: BridgeHelperEvent[],
): Promise<void> {
  try {
    const res = await fetch(`${api}/authoring/bridge/helper/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-token": token },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) console.error(`  ! could not report to Varys (${res.status})`);
  } catch (e) {
    console.error(`  ! could not report to Varys (${String(e)})`);
  }
}

/**
 * Hold the command stream open and hand each command to `onCommand`.
 *
 * Resolves when the stream ends (the server restarted, the network dropped, the token was
 * rejected) so the caller can decide whether to reconnect. It never reconnects itself: what to do
 * about a dead relay is a decision with a user-visible consequence, and burying it here would
 * make a permanently-unpaired helper look like a working one.
 *
 * Holding this stream IS what makes the helper "connected" as far as the Run button is concerned.
 * Dropping it disables the button — which is the honest answer, and why this is the last thing to
 * give up.
 */
export async function readCommands(
  api: string,
  token: string,
  onCommand: (c: BridgeCommand) => void,
): Promise<{ reason: string }> {
  const res = await fetch(`${api}/authoring/bridge/helper/commands`, {
    headers: { "x-bridge-token": token, accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) {
    return { reason: res.status === 401 ? "unauthorized" : `stream failed (${res.status})` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let sep: number;
    // biome-ignore lint: assignment-in-condition is the idiomatic frame splitter here.
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let eventType = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (eventType === "ping" || data.length === 0) continue;
      try {
        onCommand(JSON.parse(data.join("\n")) as BridgeCommand);
      } catch {
        // A frame we cannot parse is a frame from a newer Varys than this helper. Ignoring it is
        // right: the relay's contract only ever ADDS command variants.
      }
    }
  }
  return { reason: "closed" };
}
