import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface DiffResult {
  verdict: "match" | "diff";
  /** Mismatched-pixel ratio in [0, 1]. */
  score: number;
  diffImage: Buffer;
}

/**
 * Pixel-diff two PNG buffers. `threshold` is the max mismatched-pixel ratio
 * tolerated before the result is a diff. Mismatched dimensions are treated as a
 * full diff (score 1). The diff image highlights changed pixels.
 */
export function diffPng(
  baseline: Buffer,
  actual: Buffer,
  threshold: number,
): DiffResult {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(actual);

  if (a.width !== b.width || a.height !== b.height) {
    return { verdict: "diff", score: 1, diffImage: actual };
  }

  const { width, height } = a;
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: 0.1,
  });
  const score = mismatched / (width * height);
  const verdict = score <= threshold ? "match" : "diff";

  return { verdict, score, diffImage: PNG.sync.write(diff) };
}
