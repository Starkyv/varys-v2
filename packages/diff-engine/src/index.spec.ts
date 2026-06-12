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
});
