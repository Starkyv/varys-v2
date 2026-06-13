import { variablesFromSteps } from "@varys/recorder";
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

async function save(
  name?: string,
): Promise<{ ok: boolean; status?: number; id?: string; error?: string }> {
  const s = await withState((st) => ({ result: st }));
  if (!s.steps.length || !s.viewport) {
    return { ok: false, error: "nothing recorded yet" };
  }
  // A name is required: prefer the one supplied at save time, else the stored name.
  const testName = (name ?? s.name ?? "").trim();
  if (!testName) {
    return { ok: false, error: "a test name is required" };
  }
  // Declare the recording's variables (derived from its {{tokens}}) so the API and
  // the env editor know what it needs. The background store keeps only steps, so this
  // is where the declared list is attached.
  const variables = variablesFromSteps(s.steps);
  const definition: TestDefinition = {
    name: testName,
    viewport: s.viewport,
    steps: s.steps,
    ...(variables.length ? { variables } : {}),
  };
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
        return withState((s) => {
          // Drop late steps from a page whose recording was already stopped.
          if (!s.recording) return { result: { ok: false } };
          const step = msg.step as Step;
          // Only the entry navigate (step #0) is meaningful. Every later full-page load
          // is the effect of a recorded click or a server redirect — most painfully an
          // OAuth/Keycloak login dance, whose landing URL carries a single-use code/state/
          // nonce. Replaying the click reproduces the navigation with FRESH params; force-
          // navigating to the captured (now-expired) URL only hangs. So drop non-initial
          // navigates — a fresh content script records one on every page load (navigation
          // survival), and all but the first are redirect/click effects.
          if (step.type === "navigate" && s.steps.length > 0) {
            return { result: { ok: true } };
          }
          return { next: { ...s, steps: [...s.steps, step] }, result: { ok: true } };
        });
      case "varys:replace-last-type":
        // One-tap Variable/Static flip: rewrite the most recent `type` step with the
        // corrected (tokenized or literal) version the content script rebuilt.
        return withState((s) => {
          if (!s.recording) return { result: { ok: false } };
          const steps = [...s.steps];
          for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].type === "type") {
              steps[i] = msg.step as Step;
              return { next: { ...s, steps }, result: { ok: true } };
            }
          }
          return { result: { ok: false } };
        });
      case "varys:stop":
        return withState((s) => ({ next: { ...s, recording: false }, result: { ok: true } }));
      case "varys:clear":
        // Discard the whole recording (steps + viewport) and stop — a fresh start.
        return withState(() => ({
          next: { recording: false, steps: [], viewport: null, name: "recorded" },
          result: { ok: true },
        }));
      case "varys:state":
        return withState((s) => ({
          result: {
            recording: s.recording,
            stepCount: s.steps.length,
            screenshots: s.steps.filter((x) => x.type === "screenshot").length,
          },
        }));
      case "varys:save":
        return save(msg.name as string | undefined);
      default:
        return undefined;
    }
  });
});
