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
 * Which leaves the question the first version of this route did not answer: what does that shell
 * put in the `Authorization` header? Nothing it has. The OAuth token belongs to the MCP client,
 * not to the agent, so an endpoint that demanded a bearer was one the agent could not call — and
 * an agent that cannot upload falls back to base64, which is the cost this route exists to
 * remove. Hence {@link UploadsService.mintSlot}: an authenticated tool call mints an unguessable
 * URL, and the URL itself is the permission.
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

/**
 * How long a minted upload URL is worth anything.
 *
 * Longer than a handle's life because it is a different kind of thing: a handle names bytes that
 * already arrived and are waiting to be claimed, while a slot is the agent's standing permission
 * to send some. It is re-minted on every agent tool response, so the freshest one is always in
 * front of the caller and this bound is only what happens to an abandoned one.
 */
const SLOT_TTL_MS = 30 * 60_000;

/** Total bytes held across all pending uploads. The bound that stops a caller who uploads and
 *  never redeems from growing the heap without limit — refusal is the right answer there, and a
 *  loud one, because the alternative is the process dying for reasons nobody can trace back. */
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

/**
 * One minted upload URL: permission to POST screenshots, held as a capability.
 *
 * The URL IS the credential, which is the whole point of it. `/mcp` authenticates one sort of
 * caller — a person, over OAuth (ADR-0002) — and that token lives inside the MCP client's own
 * credential store, where the agent's shell cannot reach it. An agent that must `curl` a file
 * therefore has no bearer it can put on the request, and inventing one for it would mean a second
 * issuer on `/mcp`: the very thing ADR-0008 removed. A slot sidesteps that entirely. It is minted
 * BY an authenticated tool call, so it inherits that call's principal; it is unguessable, so
 * holding it is the proof; and it expires, so there is nothing to revoke.
 */
interface UploadSlot {
  /** Whose uploads these become. Carried from the tool call that minted the slot, so a handle
   *  minted through it is redeemable by exactly the principal `take` already expects. */
  ownerId: string;
  expiresAt: number;
}

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
  private readonly slots = new Map<string, UploadSlot>();
  private bytesHeld = 0;

  /**
   * Mint an upload URL for a principal — the capability an agent's shell can actually use.
   *
   * Multi-use for its lifetime, deliberately: single-use belongs on the HANDLE, not on the slot,
   * and it is already there (`take` deletes on redemption). That is where it matters, because a
   * handle is what binds one blob to one checkpoint. Making the slot single-use too would buy
   * nothing — the URL is equally secret either way — and would cost a tool round trip before
   * every capture.
   */
  mintSlot(ownerId: string): { slot: string; expiresAt: number } {
    this.forgetStale();
    const slot = `slot_${randomBytes(24).toString("base64url")}`;
    const expiresAt = Date.now() + SLOT_TTL_MS;
    this.slots.set(slot, { ownerId, expiresAt });
    return { slot, expiresAt };
  }

  /** Whose slot this is, or null if it is unknown or expired. Not consumed — see {@link mintSlot}. */
  slotOwner(slot: string): string | null {
    this.forgetStale();
    const found = this.slots.get(slot);
    return found ? found.ownerId : null;
  }

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
    for (const [slot, s] of this.slots) {
      if (now >= s.expiresAt) this.slots.delete(slot);
    }
    for (const [ref, up] of this.pending) {
      if (now >= up.expiresAt) {
        this.pending.delete(ref);
        this.bytesHeld -= up.bytes.length;
        this.log.log(`pending upload ${ref} expired unclaimed (${up.bytes.length} bytes)`);
      }
    }
  }
}
