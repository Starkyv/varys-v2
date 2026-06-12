import type { Step, TestDefinition, Viewport } from "@varys/step-schema";

/**
 * Background service worker. It owns the recording so it can outlive page loads:
 *
 *  1. Toggle the in-page overlay when the toolbar icon is clicked (no popup, so
 *     the icon click reaches us directly).
 *  2. Hold the recording state in `storage.session` — the canonical, accumulating
 *     step list. Content scripts come and go with every navigation (a login is a
 *     full page load that tears the old content script down); they ship each step
 *     here as it happens, so the recording survives the redirect.
 *  3. Save the assembled definition to the API — the content script can't reach
 *     the API cross-origin, but the background can (host_permissions).
 */
const API_BASE = "http://localhost:4000";
const KEY = "varys:recording";

interface RecState {
  recording: boolean;
  steps: Step[];
  viewport: Viewport | null;
  name: string;
}

const EMPTY: RecState = { recording: false, steps: [], viewport: null, name: "recorded" };

async function read(): Promise<RecState> {
  const got = await browser.storage.session.get(KEY);
  return (got[KEY] as RecState | undefined) ?? EMPTY;
}

// Serialize every read-modify-write so concurrent step messages (clicks/types
// firing back-to-back) can't clobber each other's append.
let lock: Promise<unknown> = Promise.resolve();
function withState<T>(fn: (s: RecState) => { next?: RecState; result: T }): Promise<T> {
  const run = lock.then(async () => {
    const cur = await read();
    const { next, result } = fn(cur);
    if (next) await browser.storage.session.set({ [KEY]: next });
    return result;
  });
  lock = run.catch(() => undefined);
  return run;
}

async function save(): Promise<{ ok: boolean; status?: number; id?: string; error?: string }> {
  const s = await withState((st) => ({ result: st }));
  if (!s.steps.length || !s.viewport) {
    return { ok: false, error: "nothing recorded yet" };
  }
  const definition: TestDefinition = { name: s.name, viewport: s.viewport, steps: s.steps };
  try {
    const res = await fetch(`${API_BASE}/tests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(definition),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: res.ok, status: res.status, id: body.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => {
    if (tab.id != null) {
      void browser.tabs.sendMessage(tab.id, { type: "varys:toggle" });
    }
  });

  // biome-ignore lint/suspicious/noExplicitAny: cross-context message payload
  browser.runtime.onMessage.addListener((msg: any) => {
    switch (msg?.type) {
      case "varys:start":
        return withState(() => ({
          next: {
            recording: true,
            steps: [],
            viewport: (msg.viewport as Viewport) ?? null,
            name: (msg.name as string) || "recorded",
          },
          result: { ok: true },
        }));
      case "varys:step":
        // Drop late steps from a page whose recording was already stopped.
        return withState((s) => ({
          next: s.recording ? { ...s, steps: [...s.steps, msg.step as Step] } : undefined,
          result: { ok: s.recording },
        }));
      case "varys:stop":
        return withState((s) => ({ next: { ...s, recording: false }, result: { ok: true } }));
      case "varys:state":
        return withState((s) => ({
          result: {
            recording: s.recording,
            stepCount: s.steps.length,
            screenshots: s.steps.filter((x) => x.type === "screenshot").length,
          },
        }));
      case "varys:save":
        return save();
      default:
        return undefined;
    }
  });
});
