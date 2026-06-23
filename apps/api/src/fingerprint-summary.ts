import type { FingerprintSummary } from "@varys/review-contract";
import type { Fingerprint } from "@varys/step-schema";

/**
 * Distil a recorded multi-signal fingerprint into the display-oriented summary the UI
 * renders — the Run-detail "what the locator was looking for" panel and the Test-detail
 * locator editor both read this shape. `id` is split out of `attributes` as `elementId`;
 * long/volatile visible text is capped. Returns null when the step has no element target
 * (navigate, full-page / region screenshots).
 */
export function summarizeFingerprint(fp: Fingerprint | undefined): FingerprintSummary | null {
  if (!fp) return null;
  const { id, ...restAttrs } = fp.attributes ?? {};
  return {
    tag: fp.tag,
    role: fp.role ?? null,
    accessibleName: fp.accessibleName ?? null,
    nameFromAttr: fp.nameFromAttr ?? false,
    // The recorded text can be long / carry volatile data — cap it for display.
    text: fp.text ? fp.text.slice(0, 400) : null,
    testId: fp.testId ?? null,
    elementId: id ?? null,
    attributes: restAttrs && Object.keys(restAttrs).length > 0 ? restAttrs : null,
    stableClasses: fp.stableClasses?.length ? fp.stableClasses : null,
    moduleClasses: fp.moduleClasses?.length ? fp.moduleClasses : null,
    ancestors: fp.ancestors?.length
      ? fp.ancestors.map((a) => {
          let s = a.tag;
          if (a.role) s += `[${a.role}]`;
          if (a.id) s += `#${a.id}`;
          else if (a.testId) s += `[data-testid="${a.testId}"]`;
          return s;
        })
      : null,
    boundingBox: fp.boundingBox ?? null,
    selectorOverride: fp.selectorOverride ?? null,
  };
}
