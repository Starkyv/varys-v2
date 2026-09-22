import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every injected constructor parameter must carry an explicit `@Inject(...)`.
 *
 * This is not style. The deployed image runs the TypeScript sources directly under `tsx`
 * (`deploy/Dockerfile.app`), and esbuild does not implement `emitDecoratorMetadata` — so
 * `design:paramtypes` is simply absent at runtime. Nest reads that metadata to discover
 * constructor dependencies; finding none, it concludes the class takes NO dependencies and
 * instantiates it with no arguments. Every parameter property is then `undefined`, and **nothing
 * fails at boot**. The first request to touch one gets a 500 reading a property of undefined.
 *
 * It is asserted HERE, statically, because no amount of E2E can catch it: the suite transforms
 * with swc (`unplugin-swc`), which DOES emit the metadata, so injection works perfectly in the
 * tests and proves nothing whatsoever about production. That is exactly how `/mcp/uploads`
 * shipped broken with a passing suite — a route Claude could not use, failing on every capture,
 * while its own E2E spec stayed green.
 *
 * So this test reads the source rather than running it. A parameter without `@Inject` is a 500
 * waiting for whichever request reaches it first.
 */

const SRC = join(__dirname, "..", "src");

/** Every `.ts` under `src/`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** Split a parameter list on its TOP-LEVEL commas — the ones inside `Map<string, string>` or a
 *  decorator's own arguments separate nothing. */
function splitParams(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if ("<([{".includes(ch)) depth++;
    else if (">)]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** Strip comments, which is where half of this repo's reasoning lives and none of its syntax. */
function decomment(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("constructor injection survives a runtime with no decorator metadata", () => {
  it("declares @Inject on every injected constructor parameter", () => {
    const offenders: string[] = [];

    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/constructor\(([\s\S]*?)\)\s*\{/g)) {
        for (const param of splitParams(match[1] ?? "")) {
          const bare = decomment(param).trim();
          // Only PARAMETER PROPERTIES are injected. A plain argument belongs to a class Nest
          // never constructs, and needs nothing.
          if (!/^@?[\w()., ]*\b(private|public|protected|readonly)\b/.test(bare)) continue;
          if (bare.includes("@Inject")) continue;
          offenders.push(`${file.slice(SRC.length + 1)}: ${bare.split("\n")[0]}`);
        }
      }
    }

    expect(offenders, `Injected without @Inject — undefined at runtime under tsx:\n${offenders.join("\n")}`).toEqual([]);
  });
});
