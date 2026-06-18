#!/usr/bin/env node
// Stub Bridge Helper (Slice 15 — Author with AI, Issue 02).
//
// A dependency-free stand-in for the real Bridge Helper: it claims a pairing code, opens the
// relay's command stream, and echoes canned events back into the web chat so the relay pipe is
// demoable end to end without the Claude Agent SDK (that arrives in Issue 03). It does NOT drive
// a browser — the live-preview pane stays empty because there's no real Authoring Session yet.
//
// Usage:
//   node scripts/bridge-stub.mjs <pairing-code>
//   VARYS_API=http://localhost:4000 node scripts/bridge-stub.mjs <pairing-code>

const API = process.env.VARYS_API ?? "http://localhost:4000";
const code = process.argv[2];

if (!code) {
  console.error("usage: node scripts/bridge-stub.mjs <pairing-code>");
  process.exit(1);
}

async function postEvents(token, events) {
  const res = await fetch(`${API}/authoring/bridge/helper/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": token },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) console.error(`  ! events POST failed (${res.status})`);
}

async function main() {
  // 1. Claim the pairing code → a chat-scoped bridge token.
  const pairRes = await fetch(`${API}/authoring/bridge/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!pairRes.ok) {
    console.error(`pair failed (${pairRes.status}) — is the code valid and unexpired?`);
    process.exit(1);
  }
  const { chatId, bridgeToken } = await pairRes.json();
  console.log(`paired → chat ${chatId}`);

  // 2. Open the command stream (this marks the helper "connected" on the server).
  const streamRes = await fetch(`${API}/authoring/bridge/helper/commands`, {
    headers: { "x-bridge-token": bridgeToken, accept: "text/event-stream" },
  });
  if (!streamRes.ok || !streamRes.body) {
    console.error(`command stream failed (${streamRes.status})`);
    process.exit(1);
  }
  console.log("connected — waiting for prompts (Ctrl-C to quit)");

  // 3. Bind a (fake) Authoring Session so the web shows the correlation, and greet.
  const sessionId = `stub-${Date.now()}`;
  await postEvents(bridgeToken, [
    { type: "session", sessionId },
    { type: "assistant", text: "(stub helper) Connected. Send a prompt and I'll echo it back." },
  ]);

  // 4. Read the SSE command stream; echo canned events for each prompt.
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    // SSE frames are separated by a blank line.
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let eventType = "message";
      const dataLines = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (eventType === "ping" || dataLines.length === 0) continue;
      let cmd;
      try {
        cmd = JSON.parse(dataLines.join("\n"));
      } catch {
        continue;
      }
      if (cmd?.type === "prompt") {
        console.log(`prompt: ${cmd.text}`);
        await postEvents(bridgeToken, [
          { type: "tool", name: "navigate", detail: cmd.text },
          { type: "assistant", text: `(stub) Would do: ${cmd.text}` },
        ]);
      }
    }
  }
  console.log("stream closed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
