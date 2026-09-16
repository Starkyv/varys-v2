import { BadRequestException } from "@nestjs/common";

/** The PNG signature: 89 50 4E 47 0D 0A 1A 0A. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Base64 (or a `data:` URL) in, PNG bytes out.
 *
 * The format check is not fussiness. These bytes become an artifact a human reviews and may
 * promote to a baseline, and the two ways this call goes wrong in practice — a `data:` prefix left
 * on, or a file PATH sent where bytes were meant — both produce something that stores perfectly
 * and renders as nothing at all. Refusing here turns a silently blank review into a message the
 * agent can act on, one tool call after the mistake rather than a day later.
 *
 * Shared by every `/mcp` surface that takes a screenshot — a run's checkpoint and evidence
 * captures, and an authored Checkpoint's proof that the state was reached. `tool` names the caller
 * so the message tells the model which of its calls to fix.
 */
export function decodePng(image: string, tool: string): Buffer {
  const raw = (image ?? "").trim();
  if (!raw) {
    throw new BadRequestException(
      `${tool} needs \`image\` — the screenshot itself, base64-encoded PNG bytes.`,
    );
  }
  // A data URL is what several capture tools hand back, so it is tolerated rather than refused.
  const base64 = raw.replace(/^data:image\/[a-z+]+;base64,/i, "");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) {
    throw new BadRequestException(`${tool}: \`image\` decoded to no bytes — is it really base64?`);
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new BadRequestException(
      `${tool}: \`image\` is not a PNG. Send the screenshot's raw bytes, base64-encoded — not a file path, not a URL, and not JPEG. Baselines are PNG, and a reviewer has to be able to put the two side by side.`,
    );
  }
  return bytes;
}
