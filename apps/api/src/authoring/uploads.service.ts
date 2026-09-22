import { randomBytes } from "node:crypto";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";

/**
 * Screenshots handed to Varys OUT OF BAND, so their bytes never travel through the model's output.
 *
 * `imagePath` already solves this — Varys opens the file itself — but only for a caller on the
 * same machine, which a deployed Varys never has. That left one route for everybody else: base64
 * inside the tool call, where a few hundred KB of PNG becomes a few hundred KB of tokens. The
 * limit that bites there is not Varys's (the body parser takes 5 MB); it is whatever caps the
 * agent's own output, and the workaround it invites — crop the screenshot until the base64 fits —
 * silently degrades the one artifact a human is going to approve as a baseline.
 *
 * So: the agent's SHELL uploads the file over plain HTTP and gets back a short handle, and the
 * tool call carries the handle. Same three guards still stand between the bytes and storage — the
 * ref is resolved before `decodePng` sees it, not instead of it.
 *
 * Held in memory, like the Bridge relay's state and under the same single-instance constraint. A
 * pending upload is worth nothing once redeemed and nothing after ten minutes, so there is no
 * durability worth buying: a restart costs the agent one re-upload, which it can do without asking
 * anybody. Nothing here is ever written to storage — an upload that is never redeemed leaves
 * nothing behind to sweep up.
 */

/** How long a handle is worth anything. Long enough for an agent to upload and then call the tool;
 *  short enough that a forgotten one is gone before it is a leak. */
const UPLOAD_TTL_MS = 10 * 60_000;

/** Total bytes held across all pending uploads. The bound that stops a caller who uploads and
 *  never redeems from growing the heap without limit — refusal is the right answer there, and a
 *  loud one, because the alternative is the process dying for reasons nobody can trace back. */
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

/** One screenshot waiting to be named by a tool call. */
interface PendingUpload {
  /** Who uploaded it. A handle is redeemable only by the principal that minted it — a ref is a
   *  bearer token for one image, and one person's capture must not become another's checkpoint. */
  ownerId: string;
  bytes: Buffer;
  expiresAt: number;
}

@Injectable()
export class UploadsService {
  private readonly log = new Logger(UploadsService.name);
  private readonly pending = new Map<string, PendingUpload>();
  private bytesHeld = 0;

  /** Accept a screenshot and mint the handle that names it. */
  put(ownerId: string, bytes: Buffer): string {
    this.forgetStale();
    if (this.bytesHeld + bytes.length > MAX_PENDING_BYTES) {
      throw new BadRequestException(
        `Too many screenshots are waiting to be claimed (${this.bytesHeld} bytes held). Each upload is claimed by the tool call that names its \`imageRef\`; one that is never named expires after ${UPLOAD_TTL_MS / 60_000} minutes.`,
      );
    }
    const ref = `upl_${randomBytes(12).toString("base64url")}`;
    this.pending.set(ref, { ownerId, bytes, expiresAt: Date.now() + UPLOAD_TTL_MS });
    this.bytesHeld += bytes.length;
    return ref;
  }

  /**
   * Redeem a handle — once.
   *
   * Returns null for a ref that is unknown, expired, already claimed, or somebody else's, and
   * deliberately does not distinguish them to the caller: they are all "this is not your image",
   * and an oracle that told a stranger which of their guesses was a real handle would be the
   * only thing a ref needs protecting from.
   */
  take(ownerId: string, ref: string): Buffer | null {
    this.forgetStale();
    const found = this.pending.get(ref);
    if (!found || found.ownerId !== ownerId) return null;
    this.pending.delete(ref);
    this.bytesHeld -= found.bytes.length;
    return found.bytes;
  }

  /** Drop what has expired. Opportunistic — on upload and on redemption — rather than on a timer,
   *  which would keep the process awake for images nobody is waiting on. */
  private forgetStale(): void {
    const now = Date.now();
    for (const [ref, up] of this.pending) {
      if (now >= up.expiresAt) {
        this.pending.delete(ref);
        this.bytesHeld -= up.bytes.length;
        this.log.log(`pending upload ${ref} expired unclaimed (${up.bytes.length} bytes)`);
      }
    }
  }
}
