/**
 * Popup UI: drives the content-script recorder and saves the result to the API.
 * API base is configurable later (storage/options); a constant for now.
 */
const API_BASE = "http://localhost:4000";

function setStatus(message: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = message;
}

async function activeTabId(): Promise<number> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) throw new Error("no active tab");
  return tab.id;
}

function send(message: unknown): Promise<{ ok?: boolean; definition?: unknown }> {
  return activeTabId().then((id) => browser.tabs.sendMessage(id, message));
}

document.getElementById("start")?.addEventListener("click", async () => {
  await send({ type: "varys:start" });
  setStatus("recording — interact with the page");
});

document.getElementById("pick")?.addEventListener("click", async () => {
  await send({ type: "varys:pick" });
  setStatus("click an element to capture a checkpoint");
});

document.getElementById("save")?.addEventListener("click", async () => {
  const { definition } = await send({ type: "varys:save", name: "recorded" });
  if (!definition) {
    setStatus("nothing recorded yet");
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/tests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(definition),
    });
    const body = await res.json();
    setStatus(res.ok ? `saved test ${body.id}` : `error: ${res.status}`);
  } catch (err) {
    setStatus(`save failed: ${(err as Error).message}`);
  }
});
