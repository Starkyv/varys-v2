import type { FingerprintPatch } from "@varys/review-contract";
import type { Fingerprint } from "@varys/step-schema";

/**
 * Merge a locator patch onto a fingerprint: each present key sets that signal (trimmed),
 * an empty value clears it; omitted keys are left untouched. Every OTHER captured signal
 * (ancestors, classes, scope, structural path, box) is preserved — a locator edit never
 * collapses the multi-signal bundle to a single selector (DESIGN §2). Clearing the
 * accessible name also drops its `nameFromAttr` companion flag. Shared by the config save
 * (which persists the merge) and the verify probe (which resolves the candidate merge).
 */
export function applyFingerprintPatch(fp: Fingerprint, patch: FingerprintPatch): Fingerprint {
  const out: Fingerprint = { ...fp };
  for (const key of ["role", "accessibleName", "text", "testId", "selectorOverride"] as const) {
    if (!(key in patch)) continue;
    const value = (patch[key] ?? "").trim();
    if (value === "") delete out[key];
    else out[key] = value;
  }
  if ("accessibleName" in patch && (patch.accessibleName ?? "").trim() === "") {
    delete out.nameFromAttr;
  }
  return out;
}

/**
 * Does a fingerprint still carry a signal the matcher can resolve on, beyond the bare
 * `tag` (which alone matches every element of that kind)? Guards against an edit that
 * clears every distinguishing signal, leaving a locator that can never resolve.
 */
export function hasMatchableSignal(fp: Fingerprint): boolean {
  return Boolean(
    fp.selectorOverride ||
      fp.testId ||
      fp.role ||
      fp.accessibleName ||
      fp.text ||
      fp.cssPath ||
      fp.scope ||
      (fp.attributes && Object.keys(fp.attributes).length > 0) ||
      (fp.stableClasses && fp.stableClasses.length > 0) ||
      (fp.ancestors && fp.ancestors.length > 0),
  );
}
