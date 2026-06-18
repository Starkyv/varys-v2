import { randomBytes, randomUUID } from "node:crypto";
import { Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type {
  BridgeChatState,
  BridgeCommand,
  BridgeEvent,
  BridgeHelperEvent,
  BridgePairResult,
} from "@varys/review-contract";
import { Observable, Subject } from "rxjs";

/** Pairing codes are short-lived: a human copies one into the helper within a couple of minutes. */
const PAIRING_TTL_MS = 2 * 60_000;

interface BridgeChat {
  chatId: string;
  /** The signed-in user (better-auth id) who owns this chat — the only one who can drive it. */
  ownerId: string;
  /** One-time pairing code; consumed (nulled) when the helper pairs. */
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  /** Chat-scoped secret the paired helper presents; null until paired. */
  bridgeToken: string | null;
  helperConnected: boolean;
  sessionId: string | null;
  /** Events to the web chat (mirrored conversation + relay-owned status). */
  toWeb: Subject<BridgeEvent>;
  /** Commands down to the helper (prompts). */
  toHelper: Subject<BridgeCommand>;
}

/**
 * The Bridge relay (Slice 15 — Author with AI). Brokers, per chat, between a signed-in web user
 * and their local Bridge Helper: prompts go down (web → helper), conversation events come up
 * (helper → web). State is in-memory and process-local — the same single-instance / sticky
 * constraint the Authoring Session service already lives under (a chat is meaningless on another
 * node). Transport is SSE + POST both directions; this service is transport-agnostic (it exposes
 * Observables + push methods the controller wraps).
 *
 * Auth is split: the web side is owner-scoped by the better-auth session (the controller passes
 * the user id); the helper side is gated by a one-time pairing code (→ a chat-scoped bridge
 * token), so the helper needs no browser cookie — like `/mcp`, but scoped and authenticated.
 */
@Injectable()
export class BridgeService {
  private readonly log = new Logger(BridgeService.name);
  private readonly chats = new Map<string, BridgeChat>();
  private readonly byCode = new Map<string, string>();
  private readonly byToken = new Map<string, string>();

  /** Create a bridge owned by the signed-in user; returns the pairing code to show in the UI. */
  create(ownerId: string): BridgeChatState {
    const chatId = randomUUID();
    const pairingCode = randomBytes(4).toString("hex");
    const chat: BridgeChat = {
      chatId,
      ownerId,
      pairingCode,
      pairingExpiresAt: Date.now() + PAIRING_TTL_MS,
      bridgeToken: null,
      helperConnected: false,
      sessionId: null,
      toWeb: new Subject<BridgeEvent>(),
      toHelper: new Subject<BridgeCommand>(),
    };
    this.chats.set(chatId, chat);
    this.byCode.set(pairingCode, chatId);
    this.log.log(`bridge ${chatId} created (pairing code issued)`);
    return this.state(chat);
  }

  /** Public read-model for the owning web user. */
  stateForOwner(chatId: string, ownerId: string): BridgeChatState {
    return this.state(this.requireOwned(chatId, ownerId));
  }

  /** Claim a pairing code (helper side) → a chat-scoped bridge token. The code is consumed. */
  claim(code: string): BridgePairResult {
    const chatId = code ? this.byCode.get(code) : undefined;
    const chat = chatId ? this.chats.get(chatId) : undefined;
    if (!chat || chat.pairingCode !== code || (chat.pairingExpiresAt ?? 0) < Date.now()) {
      throw new UnauthorizedException("Invalid or expired pairing code");
    }
    const bridgeToken = randomBytes(32).toString("base64url");
    chat.bridgeToken = bridgeToken;
    chat.pairingCode = null;
    chat.pairingExpiresAt = null;
    this.byCode.delete(code);
    this.byToken.set(bridgeToken, chat.chatId);
    this.log.log(`bridge ${chat.chatId} paired (helper token issued)`);
    return { chatId: chat.chatId, bridgeToken };
  }

  /** Push a prompt down to the helper (web side). */
  prompt(chatId: string, ownerId: string, text: string): void {
    const chat = this.requireOwned(chatId, ownerId);
    const trimmed = text.trim();
    if (!trimmed) return;
    chat.toHelper.next({ type: "prompt", text: trimmed });
  }

  /** Events the web chat consumes: a current-status snapshot first, then live events. */
  webEvents(chatId: string, ownerId: string): Observable<BridgeEvent> {
    const chat = this.requireOwned(chatId, ownerId);
    return new Observable<BridgeEvent>((subscriber) => {
      subscriber.next({ type: "status", helperConnected: chat.helperConnected, sessionId: chat.sessionId });
      const inner = chat.toWeb.subscribe(subscriber);
      return () => inner.unsubscribe();
    });
  }

  /** Commands the helper consumes. Marks the helper connected for the life of the subscription. */
  helperCommands(token: string): Observable<BridgeCommand> {
    const chat = this.requireByToken(token);
    return new Observable<BridgeCommand>((subscriber) => {
      this.setHelperConnected(chat, true);
      const inner = chat.toHelper.subscribe(subscriber);
      return () => {
        inner.unsubscribe();
        this.setHelperConnected(chat, false);
      };
    });
  }

  /** Forward helper-posted events to the web (helper side). `session` binds the Authoring
   *  Session for the slice-01 live preview and is surfaced as a `status` event. */
  helperEvents(token: string, events: BridgeHelperEvent[]): void {
    const chat = this.requireByToken(token);
    for (const e of events) {
      if (e.type === "session") {
        chat.sessionId = e.sessionId;
        this.emitStatus(chat);
      } else {
        chat.toWeb.next(e);
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────────────

  private setHelperConnected(chat: BridgeChat, connected: boolean): void {
    if (chat.helperConnected === connected) return;
    chat.helperConnected = connected;
    this.emitStatus(chat);
    this.log.log(`bridge ${chat.chatId} helper ${connected ? "connected" : "disconnected"}`);
  }

  private emitStatus(chat: BridgeChat): void {
    chat.toWeb.next({ type: "status", helperConnected: chat.helperConnected, sessionId: chat.sessionId });
  }

  private requireOwned(chatId: string, ownerId: string): BridgeChat {
    const chat = this.chats.get(chatId);
    if (!chat || chat.ownerId !== ownerId) {
      throw new NotFoundException(`Bridge chat ${chatId} not found`);
    }
    return chat;
  }

  private requireByToken(token: string): BridgeChat {
    const chatId = token ? this.byToken.get(token) : undefined;
    const chat = chatId ? this.chats.get(chatId) : undefined;
    if (!chat) throw new UnauthorizedException("Invalid bridge token");
    return chat;
  }

  private state(chat: BridgeChat): BridgeChatState {
    const codeValid = chat.pairingCode != null && (chat.pairingExpiresAt ?? 0) > Date.now();
    return {
      chatId: chat.chatId,
      pairingCode: codeValid ? chat.pairingCode : null,
      pairingExpiresAt: codeValid ? chat.pairingExpiresAt : null,
      helperConnected: chat.helperConnected,
      sessionId: chat.sessionId,
    };
  }
}
