import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { BadRequestException, Logger } from "@nestjs/common";

/** Which route a capture actually arrived by. Logged, never stored: the question it answers —
 *  "is anything still pushing bytes through the model?" — is an operator's, and it stops being
 *  interesting the moment the answer is no. */
export type ImageRoute = "path" | "ref";

const log = new Logger("Capture");

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
 * How a screenshot reaches a `/mcp` tool — by FILE, always, down exactly one of two routes.
 *
 * The routes differ only in who opens the file: `imagePath` means Varys does (the caller is on
 * this machine), `imageRef` means the caller's own shell already sent it (everyone else). What
 * they have in common is the property that matters — the bytes never enter the conversation.
 *
 * `image`, base64 inside the tool call, was the third route and is now REFUSED. A model can
 * perceive an image but it can never carry one: what it sees arrives as vision tokens, which no
 * operation turns back into PNG bytes, so filling this field meant reading the base64 in as text
 * (~100k tokens) and writing every character of it back out (~100k more), serially, before the
 * call could even be made. That round trip was the whole cost of a checkpoint, and it ended at a
 * cliff — the output cap truncates the string, and a truncated base64 decodes without complaint
 * into a perfectly-formed half-image. The field is kept on this interface ONLY so a caller still
 * sending it gets told what to do instead; see {@link readBytes}.
 */
export interface ImageArg {
  /** REFUSED. Base64-encoded PNG bytes — accepted here once, kept only to be refused by name. */
  image?: string;
  /** Absolute path to a `.png` on the machine running Varys. Loopback callers only. */
  imagePath?: string;
  /** A handle from `POST /mcp/uploads`, where the caller's own shell sent the file. The route for
   *  everyone `imagePath` cannot serve — which is everyone not on the same machine as Varys. */
  imageRef?: string;
  /** Optional hex SHA-256 of the PNG file's bytes. Verified against what actually arrived. */
  sha256?: string;
}

/** What the transport knows about a caller that its principal does not. */
export interface CallerContext {
  /** The request came in over the loopback interface, with no proxy hop claiming otherwise — so
   *  the client is a process on this very machine and `imagePath` means something. */
  local: boolean;
  /**
   * The absolute upload URL minted for THIS caller, when there is one.
   *
   * Carried so a refusal can name the exact command that would have worked, rather than describe
   * one. An agent that is told "upload it instead" has to work out where and with what; an agent
   * handed a URL it can paste has one thing left to do. It is passed in for the same reason
   * `takeUpload` is — this module stays ignorant of sessions and identities.
   */
  uploadUrl?: string | undefined;
  /**
   * Redeem an `imageRef` for the bytes the caller already uploaded, or null if it is not theirs to
   * redeem. Single use.
   *
   * Passed in rather than imported so this module stays pure and knows nothing about who is
   * calling: the controller closes over the authenticated principal, which is what makes one
   * person's upload unredeemable by another without this function having to think about identity.
   */
  takeUpload?: (ref: string) => Buffer | null;
}

/**
 * Bytes in, a *whole* PNG out — or a refusal naming what went wrong.
 *
 * The format checks are not fussiness. These bytes become an artifact a human reviews and may
 * promote to a baseline, and the ways this goes wrong in practice all produce something that
 * stores perfectly and renders as nothing, or as half a picture — the worst possible outcome,
 * because it is reviewable and wrong rather than absent and obvious. So the signature, the IEND
 * terminator and (when offered) the hash all stand between the argument and storage.
 *
 * The IEND check earned its place against base64, which is now refused outright: `Buffer.from(s,
 * "base64")` does not throw on a mangled string, so a blob cut short by an output cap decoded
 * cleanly into half an image whose signature was perfectly intact. It is kept because the failure
 * it catches is not exclusive to that route — a file read while it is still being written arrives
 * exactly as truncated, and looks exactly as valid.
 *
 * `tool` names the caller so the message tells the model which of its calls to fix.
 */
export function decodePng(source: ImageArg, tool: string, ctx: CallerContext): Buffer {
  const { bytes, route } = readBytes(source, tool, ctx);

  if (bytes.length === 0) {
    throw new BadRequestException(
      `${tool}: the capture is EMPTY — zero bytes arrived. Check the file you sent is the screenshot and that it finished being written before you sent it.`,
    );
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new BadRequestException(
      `${tool}: that is not a PNG — the file does not start with the PNG signature. Baselines are PNG, and a reviewer has to be able to put the two side by side, so JPEG and WebP are refused rather than converted. Re-capture as PNG.`,
    );
  }
  if (!bytes.subarray(-PNG_IEND.length).equals(PNG_IEND)) {
    throw new BadRequestException(
      `${tool}: the image is TRUNCATED — it starts with a valid PNG header but has no IEND terminator, so ${bytes.length} byte(s) arrived and the end of the file did not. Nothing was stored. A half-image is indistinguishable from a whole one after the fact, which is why this is checked rather than trusted. Now that captures travel as files this usually means the file was read while it was still being written: wait for the capture to finish, check its size on disk, and send it again.`,
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
        `${tool}: the image does not match the \`sha256\` you sent with it, so what arrived is not the file you hashed and nothing was stored. You said ${expected}; ${bytes.length} byte(s) arrived hashing to ${actual}. Check you hashed the same file you sent, then send it again.`,
      );
    }
  }
  // The one record of HOW the bytes arrived. Nothing downstream keeps it, and nothing should:
  // a reviewer reads the picture, and the route only matters while someone is asking whether a
  // client with a stale tool list is still trying to push captures through the model.
  log.log(`${tool}: capture accepted via ${route} (${bytes.length} bytes)`);
  return bytes;
}

/** Resolve the argument to bytes down exactly ONE of its routes, named explicitly by the caller:
 *  a route Varys inferred would be a file read nobody asked for the first time it guessed wrong. */
function readBytes(
  source: ImageArg,
  tool: string,
  ctx: CallerContext,
): { bytes: Buffer; route: ImageRoute } {
  const image = (source.image ?? "").trim();
  const imagePath = (source.imagePath ?? "").trim();
  const imageRef = (source.imageRef ?? "").trim();

  // REFUSED BEFORE ANYTHING ELSE, including before the "exactly one route" check — a caller
  // sending base64 has already paid for it in output tokens, and the only useful thing left to
  // tell it is how not to next time.
  //
  // This is enforced HERE and not merely dropped from the tool schema, because a schema is advice
  // to a client that may not have re-read it: MCP clients cache the tool list, so an agent
  // mid-session keeps offering `image` long after the field is gone. The schema stops the model
  // choosing this route; this stops the route existing.
  if (image) {
    throw new BadRequestException(
      `${tool}: \`image\` (base64) is no longer accepted, and nothing was stored. ${uploadInstruction(ctx)}\n\nIf the capture exists only as an image in your context, it cannot be sent at all — what you were shown is not bytes you can reproduce. Re-capture it to a FILE (your screenshot tool takes a path) and send the file.`,
    );
  }

  const given = [imagePath && "`imagePath`", imageRef && "`imageRef`"].filter((x): x is string =>
    Boolean(x),
  );

  if (given.length > 1) {
    throw new BadRequestException(
      `${tool}: send exactly ONE of \`imagePath\` and \`imageRef\` — you sent ${given.join(" and ")}, and with two sources there is no saying which one the stored artifact came from.`,
    );
  }
  if (given.length === 0) {
    throw new BadRequestException(`${tool} needs the screenshot itself. ${uploadInstruction(ctx)}`);
  }
  if (imagePath) return { bytes: readLocalPng(imagePath, tool, ctx), route: "path" };
  return { bytes: readUploaded(imageRef, tool, ctx), route: "ref" };
}

/**
 * The one sentence every refusal ends with: what to do instead, for THIS caller.
 *
 * Written once because it is the same instruction every time, and written with the minted URL in
 * it because an instruction an agent can paste is acted on and one it has to assemble is guessed
 * at. A loopback caller gets the path route instead — it needs no upload at all.
 */
function uploadInstruction(ctx: CallerContext): string {
  if (ctx.local) {
    return "Write the capture to a .png and send `imagePath` — the absolute path to it on this machine. Varys opens the file itself.";
  }
  const url = ctx.uploadUrl ?? "<the `upload.url` from your last tool response>";
  return `Write the capture to a .png, send the FILE, and name what comes back: \`curl -s -X POST ${url} -H "Content-Type: image/png" --data-binary @shot.png\` answers \`{"imageRef":"upl_…"}\` — put that in \`imageRef\`. No auth header: the URL is the permission, and a fresh one rides every tool response.`;
}

/**
 * Redeem a handle minted by `POST /mcp/uploads`.
 *
 * The route that exists for everyone `imagePath` cannot serve. The caller's own shell sent the
 * file over HTTP, so — exactly as with a path — no encoding happened and there is nothing that
 * could have been silently truncated. What it costs is one extra call; what it buys is that a
 * deployed Varys stops forcing a few hundred KB of base64 through the model's output, which is
 * where the pressure to crop the screenshot until it fits came from.
 *
 * A ref is single use and redeemable only by the principal that minted it. Every way it can fail
 * — unknown, expired, already claimed, somebody else's — reads the same, because they are all
 * "this is not your image" and telling them apart would only help someone guessing.
 */
function readUploaded(ref: string, tool: string, ctx: CallerContext): Buffer {
  const bytes = ctx.takeUpload?.(ref) ?? null;
  if (!bytes) {
    throw new BadRequestException(
      `${tool}: \`imageRef\` ${JSON.stringify(ref)} is not an upload you can claim — it is unknown, already used, or expired. A handle is good once and for a few minutes. ${uploadInstruction(ctx)}`,
    );
  }
  return bytes;
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
      `${tool}: \`imagePath\` is only accepted from a client on the same machine as Varys, and this connection is not one — the path would be read on the server's filesystem rather than yours. ${uploadInstruction(ctx)}`,
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
