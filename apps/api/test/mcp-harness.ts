import { createHash } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { expect } from "vitest";

/**
 * E2E harness for the `/mcp` JSON-RPC surface — the transport half of driving Varys as Claude
 * Code does, extracted so a spec can say what it is testing rather than how to post a JSON-RPC
 * envelope.
 *
 * It sits beside `auth-harness` (which mints the bearer token these calls carry) and
 * `db-harness` (which supplies the Postgres they write to), and holds no state of its own: every
 * function takes the app and the token, so one spec can drive `/mcp` as several principals —
 * a human, a Repair Agent, a second user — without any of them being implicit.
 *
 * The PNG fixture lives here for the same reason. Every `/mcp` surface that takes a screenshot
 * validates the signature bytes before storing anything, so a spec that hand-rolls a fake image
 * is one typo away from testing the refusal it did not mean to test.
 */

/** One block of an MCP tool result: text (the JSON payload) or an image (raw base64 PNG). */
export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** A `tools/call` result. Tool-level failures are `isError` results, not JSON-RPC errors — the
 *  MCP spec's own distinction, and the reason a refusal is asserted on `isError` rather than a
 *  non-200 status. */
export interface McpToolResult {
  isError?: boolean;
  content: McpContent[];
}

/** A raw JSON-RPC request on `/mcp` as whoever holds `token`. Returns the supertest chain, so a
 *  caller can assert the HTTP status itself (401 for an unknown token, 202 for a notification). */
export function mcpRpc(
  app: INestApplication,
  token: string,
  method: string,
  params: unknown,
  id: number | string | null = 1,
) {
  return request(app.getHttpServer())
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .send({ jsonrpc: "2.0", id, method, params });
}

/** Call a tool and hand back its result blocks, asserting only that the TRANSPORT succeeded.
 *  Use this when the refusal is the thing under test — `isError` is left for the caller to read. */
export async function mcpCallTool(
  app: INestApplication,
  token: string,
  name: string,
  args: unknown,
): Promise<McpToolResult> {
  const res = await mcpRpc(app, token, "tools/call", { name, arguments: args }).expect(200);
  expect(res.body.error).toBeUndefined();
  return res.body.result as McpToolResult;
}

/** Call a tool that is expected to SUCCEED and parse its JSON payload. The failure message
 *  carries the tool's own error text, because "expected false to be falsy" tells you nothing
 *  about which refusal you tripped. */
export async function mcpTool<T>(
  app: INestApplication,
  token: string,
  name: string,
  args: unknown,
): Promise<T> {
  const res = await mcpCallTool(app, token, name, args);
  expect(res.isError, res.content[0]?.text).toBeFalsy();
  return JSON.parse(res.content.find((c) => c.type === "text")?.text ?? "{}") as T;
}

/** The tool names this principal can see. The same filter gates `tools/call`, so a name absent
 *  here is a name that cannot be called — which is what makes listing it an assertion worth making. */
export async function mcpToolNames(app: INestApplication, token: string): Promise<string[]> {
  const res = await mcpRpc(app, token, "tools/list", {}).expect(200);
  return (res.body.result.tools as { name: string }[]).map((t) => t.name);
}

/** A PNG, as far as anything in these paths is concerned: the real 8-byte signature, a marker so
 *  two captures are distinguishable without pulling in an encoder, and the real IEND chunk.
 *
 *  The terminator is not decoration. `decodePng` requires it precisely because the SIGNATURE
 *  survives truncation and IEND does not, so a fixture without one is a fixture that can only
 *  exercise the refusal — see `pngTruncated`, which is that same fixture with the end cut off. */
export function pngFixture(marker: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(marker),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
}

/** What a capture cut short in transit looks like: a real header, real content, and no end —
 *  byte-for-byte what `Buffer.from(truncatedBase64, "base64")` hands back without complaint. */
export function pngTruncated(marker: string): Buffer {
  const whole = pngFixture(marker);
  return whole.subarray(0, whole.length - 12);
}

/** The hex SHA-256 an agent would compute over the file it is about to send. */
export function pngSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** {@link pngFixture} as the base64 an MCP tool argument carries. */
export function pngBase64(marker: string): string {
  return pngFixture(marker).toString("base64");
}
