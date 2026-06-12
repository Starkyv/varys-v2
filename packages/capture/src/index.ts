import type { Fingerprint } from "@varys/step-schema";

/**
 * Capture a multi-signal fingerprint for a DOM element. Runs in the browser
 * (the extension's content script). Self-contained — no imports or outer
 * references at runtime — so it can be serialized and injected into a page.
 */
export function captureFingerprint(el: Element): Fingerprint {
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

  const text = el.textContent?.trim() || undefined;
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
