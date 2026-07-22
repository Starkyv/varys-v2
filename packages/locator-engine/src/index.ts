import type { Fingerprint } from "@varys/step-schema";
import type { Locator, Page } from "playwright";

export interface ResolveResult {
  locator: Locator;
  /** The strongest signal that identified the winner: testId | id | role+name |
   *  scope | name | stableClasses | box. */
  matchedSignal: string;
  /** True when the winner wasn't identified by the fingerprint's strongest available
   *  signal (we leaned on a weaker one). */
  healed: boolean;
}

/** Marker attribute set on the chosen element so a Playwright Locator can address
 *  exactly it. Invisible — never affects rendering or the pixel diff. */
const MARKER = "data-varys-locate";
let markerSeq = 0;

/**
 * Resolve a fingerprint against a live page with a **confidence-scored** matcher.
 * Rather than first-tier-wins, it builds a small relevant candidate pool and scores
 * each element by how many signals agree — testId / id / role+name / row-scope /
 * structural anchor / stable classes / **bounding-box size** / ancestor chain — then
 * marks the single best, *unique*, above-floor winner and returns a Locator for it.
 *
 * Hashed CSS-module classes contribute only a small corroborating weight (they rotate
 * per build). Genuine ambiguity (a tie at the top) returns null → the run hard-fails
 * and the step is surfaced for repair, rather than silently acting on the wrong node.
 * The whole fingerprint bundle is fused here, so the matcher can evolve without
 * re-recording (DESIGN §2).
 *
 * **Auto-wait:** the scorer is a one-shot DOM scan (unlike Playwright's `.click()`/
 * `.fill()`, which auto-wait for their own target). After a navigation that mounts a
 * SPA — e.g. a login submit landing on the app — the target may not be rendered yet, so
 * a single scan would miss it and the run would fail spuriously. So poll the scan on an
 * interval up to `timeoutMs`, returning the first confident winner and null only after
 * the deadline. Matches Playwright's actionability waiting and fixes the whole class of
 * "element rendered late after navigation."
 */
/** The terminal outcome of a locate attempt (Slice 16.3a). `resolved` carries the winner;
 *  `ambiguous` is a near-tie the matcher refuses to guess between; `not-found` is no
 *  above-floor candidate. The verify probe surfaces all three; `resolve` collapses the
 *  last two to null (a Run hard-fails on either, identically to before). */
export type VerifyStatus = "resolved" | "ambiguous" | "not-found";
export interface VerifyOutcome {
  status: VerifyStatus;
  matchedSignal: string | null;
  healed: boolean;
}

/** One poll cycle's result, internal to this module. */
type PollResult =
  | { kind: "win"; locator: Locator; matchedSignal: string; healed: boolean }
  | { kind: "ambiguous" }
  | { kind: "none" };

/**
 * Shared poll loop behind both `resolve` and `verify`: the author override branch + the
 * scored in-page scan, retried on an interval up to `timeoutMs` to ride out late renders.
 * Returns the first confident winner; otherwise reports whether the final scan was a
 * genuine ambiguity (a tie) or simply nothing matched.
 */
async function poll(
  page: Page,
  fp: Fingerprint,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<PollResult> {
  const token = `loc${++markerSeq}`;
  // `scoreInPage` is serialized into the page via `.toString()`. Bundlers that keep
  // function names (esbuild's `keepNames`, used by tsx in the worker) rewrite its inner
  // helper consts to call a `__name(fn, "…")` runtime helper that doesn't exist in the
  // page → "ReferenceError: __name is not defined". Run it through a function built from
  // a raw string (which the bundler never transpiles) that shims `__name` first; harmless
  // when no such helper was injected (e.g. under vitest).
  const body = `var __name = function (f) { return f; }; return (${"_SRC_"})(arg);`.replace(
    "_SRC_",
    () => scoreInPage.toString(),
  );
  const runInPage = new Function("arg", body) as (arg: {
    fp: Fingerprint;
    MARKER: string;
    token: string;
  }) => { matchedSignal: string; healed: boolean } | "ambiguous" | null;

  const intervalMs = opts?.intervalMs ?? 200;
  const attempts = Math.max(1, Math.ceil((opts?.timeoutMs ?? 5000) / intervalMs));
  let lastAmbiguous = false;
  for (let i = 0; i < attempts; i++) {
    // Author override (Slice 16.2): an explicit selector wins outright when it resolves to
    // exactly one element — used as-is. A stale / non-unique / malformed override is ignored,
    // falling through to the scored bundle so the locator still self-heals.
    if (fp.selectorOverride) {
      const override = page.locator(fp.selectorOverride);
      const count = await override.count().catch(() => -1);
      if (count === 1) {
        return { kind: "win", locator: override.first(), matchedSignal: "override", healed: false };
      }
    }
    const outcome = await page.evaluate(runInPage, { fp, MARKER, token });
    if (outcome && outcome !== "ambiguous") {
      return {
        kind: "win",
        locator: page.locator(`[${MARKER}="${token}"]`).first(),
        matchedSignal: outcome.matchedSignal,
        healed: outcome.healed,
      };
    }
    lastAmbiguous = outcome === "ambiguous";
    if (i < attempts - 1) await page.waitForTimeout(intervalMs);
  }
  return lastAmbiguous ? { kind: "ambiguous" } : { kind: "none" };
}

export async function resolve(
  page: Page,
  fp: Fingerprint,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<ResolveResult | null> {
  const r = await poll(page, fp, opts);
  return r.kind === "win"
    ? { locator: r.locator, matchedSignal: r.matchedSignal, healed: r.healed }
    : null;
}

/** Like `resolve`, but for the locator-editor probe (Slice 16.3a): reports the full
 *  verdict — `resolved` (with the matched signal + healed flag), `ambiguous` (a tie), or
 *  `not-found` — instead of collapsing the last two to null. */
export async function verify(
  page: Page,
  fp: Fingerprint,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<VerifyOutcome> {
  const r = await poll(page, fp, opts);
  if (r.kind === "win") {
    return { status: "resolved", matchedSignal: r.matchedSignal, healed: r.healed };
  }
  return { status: r.kind === "ambiguous" ? "ambiguous" : "not-found", matchedSignal: null, healed: false };
}

/**
 * Runs in the page. Finds the best-scoring element for the fingerprint, tags it with
 * the marker attribute, and returns the identifying signal + healed flag — or null if
 * nothing clears the floor or the top is a tie. Self-contained (Playwright serializes
 * it), so all helpers are inline.
 */
function scoreInPage(args: {
  fp: Fingerprint;
  MARKER: string;
  token: string;
}): { matchedSignal: string; healed: boolean } | "ambiguous" | null {
  const { fp, MARKER, token } = args;
  // biome-ignore lint/suspicious/noExplicitAny: terse DOM scoring in page scope
  type El = any;
  // Page globals reached via globalThis so this file typechecks under a Node lib
  // (it is serialized and run in the browser by Playwright, where they exist).
  // biome-ignore lint/suspicious/noExplicitAny: page globals
  const g = globalThis as any;
  const doc = g.document;
  const esc = (s: string): string => (g.CSS?.escape ? g.CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));
  const isUsableId = (id: string): boolean =>
    /^[A-Za-z][\w-]*$/.test(id) && !/^tippy-\d+$/.test(id);
  const firstLine = (s: string): string =>
    s
      .split("\n")
      .map((x) => x.trim())
      .find(Boolean) ?? "";
  const isVisible = (el: El): boolean => {
    if (!el || typeof el.getClientRects !== "function") return false;
    if (el.getClientRects().length === 0) return false;
    const st = el.ownerDocument.defaultView?.getComputedStyle(el);
    return !st || (st.visibility !== "hidden" && st.display !== "none");
  };
  const innerTextOf = (el: El): string =>
    (typeof el.innerText === "string" ? el.innerText : (el.textContent ?? "")) as string;

  // Accessible name — mirrors the capture ladder so recorded names line up.
  const nameOf = (el: El): string => {
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return aria.trim();
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((id: string) => el.ownerDocument.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(" ");
      if (t) return t;
    }
    const title = el.getAttribute("title");
    if (title?.trim()) return title.trim();
    const childAria = el.querySelector("[aria-label]")?.getAttribute("aria-label");
    if (childAria?.trim()) return childAria.trim();
    const svgT = el.querySelector("svg title")?.textContent;
    if (svgT?.trim()) return svgT.trim();
    const imgAlt = el.querySelector("img[alt]")?.getAttribute("alt");
    if (imgAlt?.trim()) return imgAlt.trim();
    return firstLine(innerTextOf(el));
  };

  const classesOf = (el: El): string[] =>
    (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

  // Scroll-invariant size similarity (a card is ~the same size run to run).
  const sizeSim = (el: El): number => {
    const b = fp.boundingBox;
    if (!b) return 0;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 0;
    const dw = Math.abs(r.width - b.width) / Math.max(r.width, b.width, 1);
    const dh = Math.abs(r.height - b.height) / Math.max(r.height, b.height, 1);
    return Math.max(0, 1 - (dw + dh) / 2);
  };

  // ---- candidate pool: selective signals first, then a bounded tag sweep ----
  const pool = new Set<El>();
  const add = (el: El) => {
    if (el && isVisible(el)) pool.add(el);
  };

  // Row scopes (for repeated controls) and the nearest stable ancestor anchor both
  // narrow where we search, so the structural fallback stays precise and bounded.
  const scopeRoots: El[] = fp.scope
    ? Array.from(doc.querySelectorAll(fp.scope.container) as Iterable<El>).filter((r) =>
        innerTextOf(r).includes(fp.scope!.text),
      )
    : [];
  let anchor: El = null;
  for (const a of fp.ancestors ?? []) {
    if (a.testId) {
      anchor = doc.querySelector(`[data-testid="${esc(a.testId)}"]`);
    } else if (a.id && isUsableId(a.id)) {
      anchor = doc.getElementById(a.id);
    }
    if (anchor) break;
  }
  const roots: El[] = scopeRoots.length ? scopeRoots : anchor ? [anchor] : [doc];
  const search = (sel: string, cap = 400) => {
    for (const root of roots) {
      const found = Array.from(root.querySelectorAll(sel)).slice(0, cap);
      for (const el of found) add(el);
      if (pool.size > cap) break;
    }
  };

  if (fp.testId)
    Array.from(doc.querySelectorAll(`[data-testid="${esc(fp.testId)}"]`) as Iterable<El>).forEach(add);
  const id = fp.attributes?.id;
  if (id && isUsableId(id)) add(doc.getElementById(id));
  if (fp.role) search(`[role="${esc(fp.role)}"]`);
  if (fp.stableClasses?.length) search(fp.stableClasses.map((c) => `.${esc(c)}`).join(""));
  search(fp.tag);

  if (pool.size === 0) return null;

  // ---- score every candidate ----
  // Signal ranks (lower = stronger) for matchedSignal + healed.
  const RANK: Record<string, number> = {
    testId: 0,
    id: 1,
    "role+name": 2,
    scope: 2,
    name: 3,
    stableClasses: 3,
    box: 4,
  };

  const scoreOf = (el: El): { score: number; matched: string[] } => {
    let score = 0;
    const matched: string[] = [];

    if (fp.testId && el.getAttribute("data-testid") === fp.testId) {
      score += 100;
      matched.push("testId");
    }
    if (id && isUsableId(id) && el.id === id) {
      score += 90;
      matched.push("id");
    }
    const roleMatch = !!fp.role && el.getAttribute("role") === fp.role;
    const nameMatch = !!fp.accessibleName && nameOf(el) === fp.accessibleName;
    if (roleMatch && nameMatch) {
      score += 60;
      matched.push("role+name");
    } else {
      if (roleMatch) score += 15;
      if (nameMatch) {
        score += fp.nameFromAttr ? 45 : 28; // attribute-derived names are far more durable
        matched.push("name");
      }
    }
    // Row scope: inside one of the (unique-text) scope rows.
    if (scopeRoots.length === 1 && scopeRoots[0].contains(el)) {
      score += 50;
      matched.push("scope");
    }
    if (el.tagName.toLowerCase() === fp.tag) score += 8;

    const cls = classesOf(el);
    if (fp.stableClasses?.length) {
      const m = fp.stableClasses.filter((c) => cls.includes(c)).length;
      score += 20 * (m / fp.stableClasses.length);
      if (m === fp.stableClasses.length) matched.push("stableClasses");
    }
    // Raw (possibly build-hashed) classes: weak corroboration only.
    if (fp.moduleClasses?.length) {
      const m = fp.moduleClasses.filter((c) => cls.includes(c)).length;
      score += 4 * (m / fp.moduleClasses.length);
    }

    const ss = sizeSim(el);
    score += 24 * ss;
    if (ss > 0.95) matched.push("box");

    if (fp.domIndex != null && el.parentElement) {
      const sibs = Array.from(el.parentElement.children).filter(
        (c: El) => c.tagName === el.tagName,
      );
      if (sibs.indexOf(el) === fp.domIndex) score += 6;
    }

    // Ancestor chain similarity, split into two very different signals:
    //  • tag chain — weak and *shared*: sibling controls (13 cards' delete buttons) have the
    //    same tag path, so this is capped low; it must never be the thing that decides a winner.
    //  • ancestor id/testId — strong and *distinguishing*: a matching `item-card-<id>` on ONE
    //    candidate's chain is exactly what tells the target card's button apart from its siblings.
    //    Scored per-hit and uncapped, so a unique ancestor key can't be washed out by the tag cap
    //    (the old combined `min(16, …)` let the shared grid ancestor + tag matches saturate the cap
    //    for every sibling, erasing the one ancestor that mattered → 13-way tie → ambiguous).
    if (fp.ancestors?.length) {
      let p = el.parentElement;
      let tagChain = 0;
      let keyHits = 0;
      for (let i = 0; p && i < fp.ancestors.length; i++, p = p.parentElement) {
        const fa = fp.ancestors[i];
        if (fa.tag === p.tagName.toLowerCase()) tagChain += 1;
        if (fa.id && p.id === fa.id) keyHits += 1;
        if (fa.testId && p.getAttribute("data-testid") === fa.testId) keyHits += 1;
      }
      score += Math.min(8, tagChain);
      score += keyHits * 12;
    }

    return { score, matched };
  };

  const scored = Array.from(pool)
    .map((el) => ({ el, ...scoreOf(el) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const IDENTIFYING = new Set(Object.keys(RANK));
  const hasIdentity = best.matched.some((m) => IDENTIFYING.has(m));
  // Floor: must carry a real identifying signal and a non-trivial score.
  if (!best || best.score < 25 || !hasIdentity) return null;
  // Ambiguity: a near-tie between two different elements → refuse to guess (the verify
  // probe surfaces this as "ambiguous"; `resolve` still treats it as no match).
  if (scored[1] && scored[1].el !== best.el && best.score - scored[1].score < 6) return "ambiguous";

  const winnerRanks = best.matched
    .filter((m) => m in RANK)
    .map((m) => ({ m, r: RANK[m] }))
    .sort((a, b) => a.r - b.r);
  const matchedSignal = winnerRanks[0].m;
  const winnerBestRank = winnerRanks[0].r;

  // Strongest signal the fingerprint *could* offer (boundingBox is always present → ≤4).
  const present: number[] = [4];
  if (fp.testId) present.push(0);
  if (id && isUsableId(id)) present.push(1);
  if (fp.role && fp.accessibleName) present.push(2);
  if (fp.scope) present.push(2);
  if (fp.accessibleName) present.push(3);
  if (fp.stableClasses?.length) present.push(3);
  const topPresentRank = Math.min(...present);

  best.el.setAttribute(MARKER, token);
  return { matchedSignal, healed: winnerBestRank > topPresentRank };
}
