import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { BadRequestException } from "@nestjs/common";

/** The PNG signature: 89 50 4E 47 0D 0A 1A 0A. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The IEND chunk, byte for byte — a zero-length payload, the type, and its (constant) CRC.
 *
 * It is the last twelve bytes of every well-formed PNG, which is what makes it useful here: the
 * signature lives at the FRONT and therefore survives every kind of truncation, while IEND lives
 * at the back and survives none of them.
 */
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** Refuse to read a "screenshot" larger than this from disk. A real capture is a few hundred KB;
 *  this is the guard against a mistyped path pulling a disk image into memory. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * How a screenshot reaches a `/mcp` tool. Exactly one of `image` and `imagePath` is supplied —
 * they are two routes to the same bytes, and the difference between them matters:
 *
 * `image` sends the bytes THROUGH the model's own output, where a megabyte of base64 is a
 * megabyte of tokens that can be truncated, re-wrapped or clipped. `imagePath` does not: Varys
 * opens the file itself and the bytes never enter the conversation. Prefer the path wherever the
 * two machines are the same one.
 */
export interface ImageArg {
  /** Base64-encoded PNG bytes. A `data:` URL prefix is tolerated and stripped. */
  image?: string;
  /** Absolute path to a `.png` on the machine running Varys. Loopback callers only. */
  imagePath?: string;
  /** Optional hex SHA-256 of the PNG file's bytes. Verified against what actually arrived. */
  sha256?: string;
}

/** What the transport knows about a caller that its principal does not. */
export interface CallerContext {
  /** The request came in over the loopback interface, with no proxy hop claiming otherwise — so
   *  the client is a process on this very machine and `imagePath` means something. */
  local: boolean;
}

/**
 * Bytes in, a *whole* PNG out — or a refusal naming what went wrong.
 *
 * The format check is not fussiness. These bytes become an artifact a human reviews and may
 * promote to a baseline, and every way this call goes wrong in practice produces something that
 * stores perfectly and renders as nothing, or as half a picture:
 *
 *  - a `data:` prefix left on, or a file PATH sent where bytes were meant — caught by the
 *    signature;
 *  - **base64 that was truncated or corrupted in transit** — caught by nothing at all until this
 *    function grew an IEND check, because `Buffer.from(s, "base64")` does not throw on a mangled
 *    string. Node stops decoding at the first character outside the alphabet and returns the
 *    prefix it managed, so a blob cut in half decodes cleanly to half an image whose signature is
 *    perfectly intact. That is a stored, reviewable, *wrong* artifact — the worst possible
 *    outcome, and the reason three separate checks now stand between the argument and storage:
 *    the alphabet, the terminator, and (when offered) the hash.
 *
 * `tool` names the caller so the message tells the model which of its calls to fix.
 */
export function decodePng(source: ImageArg, tool: string, ctx: CallerContext): Buffer {
  const bytes = readBytes(source, tool, ctx);

  if (bytes.length === 0) {
    throw new BadRequestException(`${tool}: \`image\` decoded to no bytes — is it really base64?`);
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new BadRequestException(
      `${tool}: \`image\` is not a PNG. Send the screenshot's raw bytes, base64-encoded — not a file path, not a URL, and not JPEG. Baselines are PNG, and a reviewer has to be able to put the two side by side.`,
    );
  }
  if (!bytes.subarray(-PNG_IEND.length).equals(PNG_IEND)) {
    throw new BadRequestException(
      `${tool}: the image is TRUNCATED — it starts with a valid PNG header but has no IEND terminator, so ${bytes.length} byte(s) arrived and the end of the file did not. Nothing was stored. This almost always means the base64 was cut short on its way here, which base64 decoding cannot detect: the header is at the front and survives, so a half-sent image looks entirely valid until this check. Do not re-send the same string. Pass \`imagePath\` instead — the absolute path to the .png on this machine, which Varys reads itself so the bytes never pass through your output at all — or re-encode the whole file and send \`sha256\` with it so a repeat of this is caught rather than stored.`,
    );
  }

  const expected = (source.sha256 ?? "").trim().toLowerCase();
  if (expected) {
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new BadRequestException(
        `${tool}: \`sha256\` must be the 64-character hex digest of the PNG file's bytes; got ${JSON.stringify(source.sha256)}.`,
      );
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      throw new BadRequestException(
        `${tool}: the image does not match the \`sha256\` you sent with it, so it was corrupted in transit and nothing was stored. You said ${expected}; ${bytes.length} byte(s) arrived hashing to ${actual}. Send \`imagePath\` instead — the absolute path to the file on this machine — so the bytes do not travel through your output.`,
      );
    }
  }
  return bytes;
}

/** Resolve the argument pair to bytes. Exactly one route, chosen explicitly: guessing whether a
 *  string is a path or base64 is not possible in general — `/` is in the base64 alphabet — and a
 *  wrong guess here is a file read the caller did not ask for. */
function readBytes(source: ImageArg, tool: string, ctx: CallerContext): Buffer {
  const image = (source.image ?? "").trim();
  const imagePath = (source.imagePath ?? "").trim();

  if (image && imagePath) {
    throw new BadRequestException(
      `${tool}: send EITHER \`image\` (base64 bytes) or \`imagePath\` (a file on this machine), not both — with two sources there is no saying which one the stored artifact came from.`,
    );
  }
  if (!image && !imagePath) {
    throw new BadRequestException(
      `${tool} needs the screenshot itself: \`imagePath\`, the absolute path to a .png on this machine, or \`image\`, base64-encoded PNG bytes. Prefer the path — Varys reads the file directly, so the image cannot be truncated on its way through your output.`,
    );
  }
  return imagePath ? readLocalPng(imagePath, tool, ctx) : decodeBase64(image, tool);
}

/**
 * Read the file itself — the route on which no encoding happens, and therefore the route on
 * which nothing can be silently truncated.
 *
 * **Loopback callers only**, because the file that gets read is on the machine running the API,
 * not the machine running the agent. For the local install those are the same computer and a path
 * is exactly what the caller means; for anyone connecting over a network they are not, and the
 * argument would quietly turn into "read a file off the server" — so it is refused there rather
 * than served with someone else's bytes. A loopback client is a process that can already read
 * these files on its own account, which is what makes the permission it gains here zero.
 */
function readLocalPng(raw: string, tool: string, ctx: CallerContext): Buffer {
  if (!ctx.local) {
    throw new BadRequestException(
      `${tool}: \`imagePath\` is only accepted from a client on the same machine as Varys, and this connection is not one — the path would be read on the server's filesystem rather than yours. Send \`image\` (base64 PNG bytes) instead, with \`sha256\` so truncation is caught.`,
    );
  }

  let path = raw;
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      throw new BadRequestException(`${tool}: \`imagePath\` is not a usable file URL: ${raw}`);
    }
  } else if (path.startsWith("~/")) {
    path = resolvePath(homedir(), path.slice(2));
  }
  if (!isAbsolute(path)) {
    throw new BadRequestException(
      `${tool}: \`imagePath\` must be ABSOLUTE — ${JSON.stringify(raw)} is relative, and it would be resolved against the API server's working directory rather than yours, which is somewhere you did not mean.`,
    );
  }

  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      throw new BadRequestException(`${tool}: \`imagePath\` is not a file: ${path}`);
    }
    size = stat.size;
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException(
      `${tool}: cannot read \`imagePath\` ${path} — ${(err as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (err as Error).message}. Check the capture actually landed there, and give the absolute path.`,
    );
  }
  if (size > MAX_IMAGE_BYTES) {
    throw new BadRequestException(
      `${tool}: \`imagePath\` ${path} is ${size} bytes, past the ${MAX_IMAGE_BYTES}-byte limit for a screenshot. That is not a capture — check the path.`,
    );
  }
  return readFileSync(path);
}

/**
 * Decode base64, having first checked it is base64 — which Node will not do for you.
 *
 * The alphabet check catches a blob that picked up a stray character; it cannot catch one that
 * was merely cut short, because every character of a truncated string is still valid. The IEND
 * check in {@link decodePng} is what catches that one.
 */
function decodeBase64(raw: string, tool: string): Buffer {
  // A data URL is what several capture tools hand back, so it is tolerated rather than refused.
  const stripped = raw.replace(/^data:image\/[a-z+]+;base64,/i, "");
  // Whitespace is how a long string survives being wrapped, and carries no meaning.
  const compact = stripped.replace(/\s+/g, "");
  // base64url (`-_`) is accepted too: Node decodes it, and refusing it would only be pedantry.
  if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(compact)) {
    const bad = compact.match(/[^A-Za-z0-9+/\-_=]/)?.[0] ?? "";
    throw new BadRequestException(
      `${tool}: \`image\` is not valid base64 — it contains ${JSON.stringify(bad)}. Node would have decoded the part before that character and silently discarded the rest, leaving a half-image nobody could tell from a whole one, so it is refused instead. Send \`imagePath\` (the absolute path to the .png on this machine) and skip encoding altogether.`,
    );
  }
  if (compact.replace(/=+$/, "").length % 4 === 1) {
    throw new BadRequestException(
      `${tool}: \`image\` is not a whole base64 string — its length cannot encode any number of bytes, which means it was cut short. Send \`imagePath\` (the absolute path to the .png on this machine) instead of re-sending it.`,
    );
  }
  return Buffer.from(compact, "base64");
}
