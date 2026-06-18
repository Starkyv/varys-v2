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
// The API origin the extension talks to. Build-time configurable via WXT_API_BASE
// (WXT/Vite inlines it at build); defaults to localhost for dev. For the team build,
// set WXT_API_BASE=https://varys.datagenie.ai.
const API_BASE = import.meta.env.WXT_API_BASE ?? "http://localhost:4000";
const KEY = "varys:recording";

// better-auth's session cookie. The extension can't read whether it's signed in by
// CALLING the API (its cross-site request doesn't carry a SameSite=Lax cookie), so it
// checks the cookie's presence directly via the cookies API. Cookies are host-scoped
// (port-agnostic), so reading at the API origin finds the session cookie set by the web
// app. Presence ⇒ signed in (drives the panel's Online/Offline marker).
const AUTH_COOKIE = "better-auth.session_token";
async function isSignedIn(): Promise<boolean> {
  // The session cookie is Secure (SameSite=None), so it only matches a secure URL — read
  // it via https (cookies are host-scoped / port-agnostic, so the host is what matters).
  // Fall back to http in case a deployment runs without secure cookies.
  const secureUrl = API_BASE.replace(/^http:/, "https:");
  for (const url of [secureUrl, API_BASE]) {
    const c = await browser.cookies.get({ url, name: AUTH_COOKIE }).catch(() => null);
    if (c) return true;
  }
  return false;
}

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
      // Reuse the logged-in web session: send the API-origin session cookie so the
      // guarded route accepts the save (Slice 10 / Issue 2). The API allows credentialed
      // CORS for chrome-extension:// origins.
      //
      // KNOWN CAVEAT (cross-origin cookie): a SameSite=Lax cookie isn't sent on the
      // extension's cross-site request, and in local dev the session cookie is scoped to
      // the web origin (:5174), not the API port (:4000). If a logged-in save returns 401,
      // the fallback is `chrome.cookies` (host permission) → read the session cookie and
      // attach it explicitly. Verify with a manual smoke once the guard is live.
      credentials: "include",
    });
    if (res.status === 401) {
      return { ok: false, status: 401, error: "not signed in (open the Varys web app and sign in first)" };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: res.ok, status: res.status, id: body.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export default defineBackground(() => {
  browser.action.onClicked.addListener(async (tab) => {
    const tabId = tab.id;
    if (tabId == null) return;
    try {
      // The common path: a content script is already running on this tab.
      await browser.tabs.sendMessage(tabId, { type: "varys:toggle" });
    } catch {
      // No receiving end — the content script isn't on this tab (e.g. a tab that
      // was open before the extension loaded/updated). Inject it on demand, then
      // toggle. Restricted pages (chrome://, the Web Store, the new-tab page) will
      // reject injection too; there's nothing to toggle there, so ignore it.
      try {
        await browser.scripting.executeScript({
          target: { tabId },
          files: ["content-scripts/content.js"],
        });
        await browser.tabs.sendMessage(tabId, { type: "varys:toggle" });
      } catch {
        /* page doesn't allow content scripts — nothing to do */
      }
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
          // Name screenshot checkpoints authoritatively from the canonical store. The
          // content script derives names from a client-side counter it rebuilds on each
          // page load via best-effort messaging — so across a fast navigation the next
          // page can read a stale count and restart numbering, producing colliding names
          // (screenshot-1, screenshot-1, …). Numbering here, where the full recording
          // lives, guarantees every checkpoint name is unique and sequential.
          const stored =
            step.type === "screenshot"
              ? { ...step, name: `screenshot-${s.steps.filter((x) => x.type === "screenshot").length + 1}` }
              : step;
          return { next: { ...s, steps: [...s.steps, stored] }, result: { ok: true } };
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
      case "varys:auth-check":
        return isSignedIn().then((signedIn) => ({ signedIn }));
      case "varys:save":
        return save(msg.name as string | undefined);
      default:
        return undefined;
    }
  });

  // Push the signed-in / signed-out state to open panels the moment it changes (sign-in
  // or sign-out in the web app), so the Online/Offline marker flips live without polling.
  browser.cookies.onChanged.addListener(async (change) => {
    if (change.cookie.name !== AUTH_COOKIE) return;
    const signedIn = await isSignedIn();
    const tabs = await browser.tabs.query({});
    for (const t of tabs) {
      if (t.id != null) {
        void browser.tabs.sendMessage(t.id, { type: "varys:auth", signedIn }).catch(() => {});
      }
    }
  });
});
