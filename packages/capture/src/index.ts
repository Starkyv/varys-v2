import type { Fingerprint } from "@varys/step-schema";

/** Capture intent. `climb` rises from an inner node (an icon `<svg>`, a `<span>`)
 *  to the actionable control — for click targets. Screenshot targets omit it: you
 *  want the exact framed element. */
export interface CaptureOptions {
  climb?: boolean;
}

/**
 * Capture a multi-signal fingerprint for a DOM element. Runs in the browser
 * (the extension's content script). Self-contained — no imports or outer
 * references at runtime — so it can be serialized and injected into a page.
 *
 * The bundle is captured whole (DESIGN §2) so the resolver can fuse signals and
 * evolve without re-recording. Beyond the raw element it captures: a durable
 * accessible name (with provenance), ancestor ids for structural anchoring, a
 * row scope for repeated controls, and a stable-class subset — and it rejects
 * generated ids and climbs to the real control for clicks.
 */
export function captureFingerprint(el: Element, opts?: CaptureOptions): Fingerprint {
  // Click targets: the user usually clicks an inner <svg>/<span>/icon, not the
  // control. Climb to the nearest actionable ancestor so the fingerprint carries the
  // control's identity (role/id/label). Screenshot targets keep the exact element,
  // except an SVG-internal node rises to its <svg> root (you framed the icon, not a path).
  if (opts?.climb) {
    const actionable = el.closest(
      'a, button, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="tab"], [role="option"], input, select, textarea, label, [onclick], [tabindex]',
    );
    if (actionable) el = actionable;
  } else if (el.namespaceURI === "http://www.w3.org/2000/svg") {
    const svg = el.closest("svg");
    if (svg) el = svg;
  }

  // A usable id is author-stable: starts with a letter, plain chars, and not a
  // library-generated id (tippy-347, React useId ":r1:") that changes every render.
  const isUsableId = (id: string): boolean =>
    /^[A-Za-z][\w-]*$/.test(id) && !/^tippy-\d+$/.test(id);

  // A class looks build-hashed (rotates per deploy) when it carries a CSS-modules
  // triple-underscore (`Name__local___hash`) or a trailing alphanumeric hash segment
  // (`Card_root__a3f9`, `view___6nHPr`). Such classes are not durable identity.
  const looksHashed = (c: string): boolean => {
    if (c.includes("___")) return true;
    const seg = c.split(/[_-]/).pop() ?? "";
    return seg.length >= 4 && /\d/.test(seg) && /[A-Za-z]/.test(seg);
  };

  const firstLine = (s: string): string | undefined =>
    s
      .split("\n")
      .map((x) => x.trim())
      .find(Boolean);

  const rawId = el.getAttribute("id") ?? "";
  const usableId = rawId && isUsableId(rawId) ? rawId : undefined;

  const STABLE_ATTRS = ["name", "type", "role", "aria-label", "data-testid", "placeholder", "alt", "title"];
  const attributes: Record<string, string> = {};
  if (usableId) attributes.id = usableId; // drop generated ids — they never match on rerun
  for (const attr of Array.from(el.attributes)) {
    if (STABLE_ATTRS.includes(attr.name)) attributes[attr.name] = attr.value;
  }

  // Ancestors (nearest first) carry id/testId so a structural path can anchor at the
  // nearest stable ancestor instead of climbing all the way to <body>.
  const ancestors: { tag: string; role?: string; id?: string; testId?: string }[] = [];
  let parent = el.parentElement;
  while (parent && ancestors.length < 6) {
    const pid = parent.getAttribute("id") ?? "";
    ancestors.push({
      tag: parent.tagName.toLowerCase(),
      role: parent.getAttribute("role") ?? undefined,
      id: pid && isUsableId(pid) ? pid : undefined,
      testId: parent.getAttribute("data-testid") ?? undefined,
    });
    parent = parent.parentElement;
  }

  const sameTagSiblings = el.parentElement
    ? Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName)
    : [];
  const domIndex = sameTagSiblings.indexOf(el);

  // Classes: keep the whole list as weak corroboration, plus a durable subset with
  // build-hashed and purely-numeric classes removed; utility-class soup (>3) is
  // dropped wholesale rather than recording many fragile classes.
  const allClasses = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  let stableClasses = allClasses.filter((c) => !/^\d+$/.test(c) && !looksHashed(c));
  if (stableClasses.length > 3) stableClasses = [];

  // Rendered text (innerText) excludes non-rendered content (SVG <metadata>, <script>,
  // hidden nodes) that would poison the signal; capped, since a container's text is huge.
  const TEXT_MAX = 200;
  const rendered = el instanceof HTMLElement ? el.innerText : el.textContent;
  const rawText = rendered?.trim() || undefined;
  const text = rawText && rawText.length > TEXT_MAX ? rawText.slice(0, TEXT_MAX) : rawText;

  // Accessible-name ladder with provenance: attribute-derived names are durable;
  // a text-derived name is only the first visible line, never the whole dump.
  let accessibleName: string | undefined;
  let nameFromAttr = false;
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) {
    accessibleName = aria;
    nameFromAttr = true;
  }
  if (!accessibleName) {
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(" ");
      if (t) {
        accessibleName = t;
        nameFromAttr = true;
      }
    }
  }
  if (!accessibleName) {
    const title = el.getAttribute("title")?.trim();
    if (title) {
      accessibleName = title;
      nameFromAttr = true;
    }
  }
  // Only borrow a descendant's aria-label when the element has NO text of its own —
  // i.e. it's genuinely icon-only (<button><svg aria-label="Close"/></button>). An
  // unscoped descendant search would otherwise hijack any container that merely
  // *encloses* a labelled control (a panel around a "Pagination" nav, a card around a
  // "More options" menu) and stamp that volatile child label as the container's own
  // high-confidence name. A text-bearing element uses its own content instead (below).
  if (!accessibleName && !rawText) {
    const childAria = el.querySelector("[aria-label]")?.getAttribute("aria-label")?.trim();
    if (childAria) {
      accessibleName = childAria;
      nameFromAttr = true;
    }
  }
  // Same rule for an icon's <title>/alt: only when the element has no text of its own,
  // so a labelled icon *inside* a text-bearing control can't override the control's name.
  if (!accessibleName && !rawText) {
    const svgTitle = el.querySelector("svg title")?.textContent?.trim();
    if (svgTitle) {
      accessibleName = svgTitle;
      nameFromAttr = true;
    }
  }
  if (!accessibleName && !rawText) {
    const imgAlt = el.querySelector("img[alt]")?.getAttribute("alt")?.trim();
    if (imgAlt) {
      accessibleName = imgAlt;
      nameFromAttr = true;
    }
  }
  if (!accessibleName && rawText) {
    accessibleName = firstLine(rawText);
    nameFromAttr = false;
  }

  // Row scope: when the target sits in a repeated container, record "the element in
  // the row that says <text>" — a distinguishing visible line verified unique among
  // such containers. Survives reordering/insertion where :nth-of-type would not.
  let scope: { container: string; text: string } | undefined;
  const rowEl = el.closest('li, tr, [role="row"], [role="listitem"], article');
  if (rowEl && rowEl !== el) {
    const role = rowEl.getAttribute("role");
    const tag = rowEl.tagName.toLowerCase();
    const container =
      tag === "li" || tag === "tr" || tag === "article" ? tag : role ? `[role="${role}"]` : tag;
    const rowRendered = rowEl instanceof HTMLElement ? rowEl.innerText : (rowEl.textContent ?? "");
    const candidates = rowRendered
      .split("\n")
      .map((x) => x.trim())
      .filter((l) => l.length >= 2 && l.length <= 60 && /[A-Za-z]/.test(l));
    const peers = Array.from(el.ownerDocument.querySelectorAll(container));
    const distinguishing = candidates.find(
      (line) =>
        peers.filter((p) => (p instanceof HTMLElement ? p.innerText : (p.textContent ?? "")).includes(line))
          .length === 1,
    );
    if (distinguishing) scope = { container, text: distinguishing };
  }

  const rect = el.getBoundingClientRect();

  return {
    testId: el.getAttribute("data-testid") ?? undefined,
    role: el.getAttribute("role") ?? undefined,
    accessibleName,
    nameFromAttr: accessibleName ? nameFromAttr : undefined,
    text,
    tag: el.tagName.toLowerCase(),
    attributes: Object.keys(attributes).length ? attributes : undefined,
    ancestors: ancestors.length ? ancestors : undefined,
    domIndex: domIndex >= 0 ? domIndex : undefined,
    neighborText: undefined,
    scope,
    moduleClasses: allClasses.length ? allClasses : undefined,
    stableClasses: stableClasses.length ? stableClasses : undefined,
    boundingBox: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
  };
}
