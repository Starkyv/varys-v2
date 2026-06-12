import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { diffPng } from "./index";

function solid(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    png.data[o] = r;
    png.data[o + 1] = g;
    png.data[o + 2] = b;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

function solidWithRegion(
  w: number,
  h: number,
  base: [number, number, number],
  region: { x: number; y: number; width: number; height: number },
  color: [number, number, number],
): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inRegion =
        x >= region.x &&
        x < region.x + region.width &&
        y >= region.y &&
        y < region.y + region.height;
      const [r, g, b] = inRegion ? color : base;
      const o = (y * w + x) * 4;
      png.data[o] = r;
      png.data[o + 1] = g;
      png.data[o + 2] = b;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("diffPng", () => {
  it("identical images match with score 0", () => {
    const r = diffPng(solid(10, 10, [0, 0, 255]), solid(10, 10, [0, 0, 255]), 0.01);
    expect(r.verdict).toBe("match");
    expect(r.score).toBe(0);
  });

  it("fully different images diff with a score above threshold", () => {
    const r = diffPng(solid(10, 10, [0, 0, 255]), solid(10, 10, [255, 0, 0]), 0.01);
    expect(r.verdict).toBe("diff");
    expect(r.score).toBeGreaterThan(0.01);
    expect(r.diffImage.length).toBeGreaterThan(0);
  });

  it("ignores masked regions", () => {
    const baseline = solid(10, 10, [0, 0, 255]);
    const region = { x: 0, y: 0, width: 4, height: 4 };
    const actual = solidWithRegion(10, 10, [0, 0, 255], region, [255, 0, 0]);

    // The 4x4 corner (16% of pixels) differs → a diff without a mask.
    expect(diffPng(baseline, actual, 0.01).verdict).toBe("diff");
    // Masking that corner makes it match.
    expect(diffPng(baseline, actual, 0.01, [region]).verdict).toBe("match");
  });
});
