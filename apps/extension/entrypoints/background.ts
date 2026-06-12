/**
 * Background service worker. Two jobs:
 *  1. Toggle the in-page recorder overlay when the toolbar icon is clicked
 *     (there is no popup, so the icon click reaches us directly).
 *  2. Save the recorded definition to the API — the content script can't reach
 *     the API cross-origin, but the background can (host_permissions).
 */
const API_BASE = "http://localhost:4000";

export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => {
    if (tab.id != null) {
      void browser.tabs.sendMessage(tab.id, { type: "varys:toggle" });
    }
  });

  // biome-ignore lint/suspicious/noExplicitAny: cross-context message payload
  browser.runtime.onMessage.addListener(async (msg: any) => {
    if (msg?.type !== "varys:save") return undefined;
    try {
      const res = await fetch(`${API_BASE}/tests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg.definition),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string };
      return { ok: res.ok, status: res.status, id: body.id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
});
