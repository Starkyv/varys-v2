import type { Fingerprint } from "@varys/step-schema";

/**
 * Capture a multi-signal fingerprint for a DOM element. Runs in the browser
 * (the extension's content script). Self-contained — no imports or outer
 * references at runtime — so it can be serialized and injected into a page.
 */
export function captureFingerprint(el: Element): Fingerprint {
  // SVG icons (and their inner <path>/<g>/<use>) are almost never the intended click
  // target — the actionable control is a wrapping button/anchor. Climb to it so the
  // fingerprint carries stable identity (role/id/label) instead of SVG internals (a
  // generated id="Capa_1" or the <metadata> MIME string), which don't locate anything.
  if (el.namespaceURI === "http://www.w3.org/2000/svg") {
    const actionable = el.closest(
      'a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input, label, [onclick], [tabindex]',
    );
    if (actionable) el = actionable;
  }

  const STABLE_ATTRS = [
    "id",
    "name",
    "type",
    "role",
    "aria-label",
    "data-testid",
    "placeholder",
    "alt",
    "title",
  ];

  const attributes: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (STABLE_ATTRS.includes(attr.name)) attributes[attr.name] = attr.value;
  }

  const ancestors: { tag: string; role?: string }[] = [];
  let parent = el.parentElement;
  while (parent && ancestors.length < 5) {
    ancestors.push({
      tag: parent.tagName.toLowerCase(),
      role: parent.getAttribute("role") ?? undefined,
    });
    parent = parent.parentElement;
  }

  const sameTagSiblings = el.parentElement
    ? Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName)
    : [];
  const domIndex = sameTagSiblings.indexOf(el);

  const moduleClasses = (el.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter(Boolean);

  // Prefer rendered text (innerText) over textContent: it excludes non-rendered content
  // — an inline SVG's <metadata>/<dc:format> ("image/svg+xml"), <script>/<style>, and
  // hidden nodes — that would otherwise poison the text signal and the matcher. Then cap
  // it: textContent of a container is the whole subtree's text (tens of KB, double-stored
  // via accessibleName below), whereas a real label is short.
  const TEXT_MAX = 200;
  const rendered = el instanceof HTMLElement ? el.innerText : el.textContent;
  const rawText = rendered?.trim() || undefined;
  const text = rawText && rawText.length > TEXT_MAX ? rawText.slice(0, TEXT_MAX) : rawText;
  const rect = el.getBoundingClientRect();

  return {
    testId: el.getAttribute("data-testid") ?? undefined,
    role: el.getAttribute("role") ?? undefined,
    accessibleName: el.getAttribute("aria-label") ?? text,
    text,
    tag: el.tagName.toLowerCase(),
    attributes: Object.keys(attributes).length ? attributes : undefined,
    ancestors: ancestors.length ? ancestors : undefined,
    domIndex: domIndex >= 0 ? domIndex : undefined,
    neighborText: undefined,
    moduleClasses: moduleClasses.length ? moduleClasses : undefined,
    boundingBox: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
  };
}
