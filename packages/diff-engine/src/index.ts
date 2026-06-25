import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffResult {
  verdict: "match" | "diff";
  /** Mismatched-pixel ratio in [0, 1]. */
  score: number;
  diffImage: Buffer;
}

function paintRect(
  data: Buffer,
  width: number,
  height: number,
  rect: Rect,
): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.floor(rect.x + rect.width));
  const y1 = Math.min(height, Math.floor(rect.y + rect.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * 4;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
}

/**
 * Pixel-diff two PNG buffers. `threshold` is the max mismatched-pixel ratio
 * tolerated before the result is a diff. `pixelThreshold` (0..1) is the per-pixel
 * colour sensitivity passed to pixelmatch — how different a single pixel's colour
 * must be to count as changed; higher absorbs anti-aliasing and rendering noise.
 * Mismatched dimensions are treated as a full diff (score 1). The diff image
 * highlights changed pixels.
 */
export function diffPng(
  baseline: Buffer,
  actual: Buffer,
  threshold: number,
  masks: Rect[] = [],
  pixelThreshold = 0.1,
): DiffResult {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(actual);

  if (a.width !== b.width || a.height !== b.height) {
    return { verdict: "diff", score: 1, diffImage: actual };
  }

  const { width, height } = a;
  // Neutralize masked regions in both images so they can't contribute a diff.
  for (const mask of masks) {
    paintRect(a.data, width, height, mask);
    paintRect(b.data, width, height, mask);
  }
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: pixelThreshold,
  });
  const score = mismatched / (width * height);
  const verdict = score <= threshold ? "match" : "diff";

  return { verdict, score, diffImage: PNG.sync.write(diff) };
}
