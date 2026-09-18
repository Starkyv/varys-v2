import { randomBytes, randomUUID } from "node:crypto";
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  type AgentRunRequestPhase,
  type AgentRunRequestState,
  type BridgeChatState,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeHelperEvent,
  type BridgeHelperPresence,
  type BridgePairResult,
  isAgentRunRequestInFlight,
} from "@varys/review-contract";
import { Observable, Subject } from "rxjs";

/** Pairing codes are short-lived: a human copies one into the helper within a couple of minutes. */
const PAIRING_TTL_MS = 2 * 60_000;

/**
 * How long a run request has to turn into a Run before it lapses.
 *
 * The bound exists because the press writes nothing: with no row to look at, a request that is
 * never answered is indistinguishable from one still in flight, and the author is left watching a
 * spinner decide nothing. ADR 0003 settles the principle for unclaimed repair work — an inability
 * to guarantee that something happens must be visible, never silent — and it holds here for the
 * same reason.
 *
 * Two minutes is a helper launching Claude and Claude reaching `start_agent_run`, with room for a
 * cold start. Overridable via `VARYS_AGENT_RUN_REQUEST_MS` (the E2E tests set it low so the lapse
 * path is exercised in a second rather than skipped).
 */
function requestTtlMs(): number {
  const n = Number(process.env.VARYS_AGENT_RUN_REQUEST_MS);
  return Number.isFinite(n) && n >= 50 ? n : 120_000;
}

/** How long a finished request (fulfilled or lapsed) stays readable before it is forgotten. Long
 *  enough that a poller sees the outcome it was waiting for; short enough that nothing piles up. */
const REQUEST_RETAIN_MS = 5 * 60_000;

/** One outstanding run request. Transient, owner-scoped, and never written anywhere. */
interface AgentRunRequest {
  ownerId: string;
  testId: string;
  /** The chat whose helper it was handed to — evidence for a reader, not an address. */
  chatId: string;
  requestedAt: number;
  /** Moves out once when the helper acknowledges; see {@link BridgeService.helperEvents}. */
  lapsesAt: number;
  acknowledgedAt: number | null;
  runId: string | null;
}

/** Owner + test. Owner-scoped throughout, so one user's outstanding request is neither visible to
 *  nor blocking for another — the `\u0000` cannot occur in either id, so no pair of distinct
 *  (owner, test) ever collides on one key. */
function requestKey(ownerId: string, testId: string): string {
  return `${ownerId}\u0000${testId}`;
}

/** The state a test with no request on record is reported in. */
function noRequest(testId: string): AgentRunRequestState {
  return {
    testId,
    phase: "none",
    requestedAt: null,
    lapsesAt: null,
    acknowledgedAt: null,
    runId: null,
  };
}

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
  /** Unix ms the helper last took hold of the command stream — how the newest of several paired
   *  helpers is picked when a run request has to choose one. */
  helperConnectedAt: number | null;
  sessionId: string | null;
  /** Events to the web chat (mirrored conversation + relay-owned status). */
  toWeb: Subject<BridgeEvent>;
  /** Commands down to the helper (chat prompts, and requests to run an Agent-Driven Test). */
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
 *
 * Slice 17 widens the downward channel from prompts to prompts-and-run-requests. No new
 * credential and no new transport: a run request reuses both halves of that split unchanged, so
 * it can only ever be sent by the signed-in owner and can only ever reach a helper they
 * themselves paired.
 */
@Injectable()
export class BridgeService {
  private readonly log = new Logger(BridgeService.name);
  private readonly chats = new Map<string, BridgeChat>();
  private readonly byCode = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  /** Run requests in flight, keyed by owner + test. In-memory and process-local like the rest of
   *  the relay's state — nothing durable is written by a request at any point in its life. */
  private readonly runRequests = new Map<string, AgentRunRequest>();

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
      helperConnectedAt: null,
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

  /**
   * Whether this user has a Bridge Helper listening right now, and which chat it is on.
   *
   * Addressed by OWNER rather than by chat id, because the Run control on a test page is nowhere
   * near a chat and has no id to quote. That is also what makes reaching somebody else's helper
   * unrepresentable rather than merely forbidden: there is no field in which to name one.
   */
  helperPresence(ownerId: string): BridgeHelperPresence {
    const chat = this.newestConnected(ownerId);
    return { helperConnected: chat != null, chatId: chat?.chatId ?? null };
  }

  /**
   * Ask this user's own Claude to run an Agent-Driven Test (web side).
   *
   * Nothing durable is written here and none is meant to be: the Run comes into existence when
   * Claude calls `start_agent_run`, which is where the `missing` rows are seeded and the
   * Wall-Clock Lease is stamped. A Run created at the press would be a Run with no session behind
   * it, and a wedged helper would leave it sitting as a failure nobody ever attempted.
   *
   * Returns the chat it was handed to, so the caller can say WHICH helper heard it.
   */
  requestAgentRun(
    ownerId: string,
    request: { testId: string; environmentId: string | null },
  ): { chatId: string; state: AgentRunRequestState } {
    this.forgetStaleRequests();
    // Checked on the RELAY, not only by disabling the button. A disabled button is a courtesy one
    // browser tab extends to itself; two tabs, or a reload, would each press once and start two
    // sessions against the same test on the same machine.
    const outstanding = this.runRequests.get(requestKey(ownerId, request.testId));
    if (outstanding && isAgentRunRequestInFlight(this.phaseOf(outstanding))) {
      throw new ConflictException(
        "You have already asked your Claude to run this test and that request is still open. Wait for it to start, or for it to lapse, before asking again.",
      );
    }

    const chat = this.newestConnected(ownerId);
    if (!chat) {
      throw new ConflictException(
        "No Bridge Helper is paired, so there is nothing on your machine to run this. Start one from Author with AI and pair it, then press Run again.",
      );
    }
    chat.toHelper.next({
      type: "run-agent-test",
      testId: request.testId,
      environmentId: request.environmentId,
    });
    const now = Date.now();
    const record: AgentRunRequest = {
      ownerId,
      testId: request.testId,
      chatId: chat.chatId,
      requestedAt: now,
      lapsesAt: now + requestTtlMs(),
      acknowledgedAt: null,
      runId: null,
    };
    this.runRequests.set(requestKey(ownerId, request.testId), record);
    this.log.log(`bridge ${chat.chatId} asked to run agent test ${request.testId}`);
    return { chatId: chat.chatId, state: this.stateOf(record) };
  }

  /**
   * What became of this user's request for this test — the web app's only account of the gap
   * between the press and the Run appearing.
   *
   * The lapse is computed here rather than fired by a timer. A timer would have to be cancelled on
   * every other transition and would keep the process awake for a request nobody is watching;
   * a deadline that has passed is the same fact, and it is true whether or not anyone asks.
   */
  runRequestState(ownerId: string, testId: string): AgentRunRequestState {
    this.forgetStaleRequests();
    const record = this.runRequests.get(requestKey(ownerId, testId));
    return record ? this.stateOf(record) : noRequest(testId);
  }

  /**
   * A Run was started for this test by this user — the request is fulfilled.
   *
   * Called from the `start_agent_run` handler, which is the only thing in Varys that can create an
   * Agent Run Session, and which knows the principal who called it. Matching on the owner and not
   * merely the test is what keeps one person's request from being closed out by somebody else's
   * session against the same test.
   *
   * Nothing downstream depends on this: it reports, it does not gate. A run started by hand from a
   * terminal, with no request behind it, matches nothing here and is entirely unaffected.
   */
  noteAgentRunStarted(ownerId: string, testId: string, runId: string): void {
    const record = this.runRequests.get(requestKey(ownerId, testId));
    // Only an OPEN request can be fulfilled, and a lapse is final. Once Varys has said it asked
    // and heard nothing, a session that turns up afterwards does not retract that: the Run is
    // real and appears under Runs like any other, but the author is not pulled into it from a
    // page they stopped watching minutes ago, and a request that ended does not un-end.
    if (!record || !isAgentRunRequestInFlight(this.phaseOf(record))) return;
    record.runId = runId;
    this.log.log(`bridge run request for agent test ${testId} fulfilled by run ${runId}`);
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
      } else if (e.type === "agent-run-launched") {
        this.acknowledgeRunRequest(chat, e.testId);
      } else {
        chat.toWeb.next(e);
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────────────

  /**
   * The helper says it has launched Claude for this test.
   *
   * Acknowledgement buys ONE more bound rather than cancelling the deadline. A helper that
   * answered has earned the time Claude needs to reach `start_agent_run`; it has not earned
   * forever, and a request with no deadline is a Run button that never comes back.
   */
  private acknowledgeRunRequest(chat: BridgeChat, testId: string): void {
    const record = this.runRequests.get(requestKey(chat.ownerId, String(testId ?? "").trim()));
    if (!record || record.acknowledgedAt || !isAgentRunRequestInFlight(this.phaseOf(record))) return;
    const now = Date.now();
    record.acknowledgedAt = now;
    record.lapsesAt = now + requestTtlMs();
    this.log.log(`bridge ${chat.chatId} acknowledged the run request for agent test ${testId}`);
  }

  private phaseOf(record: AgentRunRequest, now = Date.now()): AgentRunRequestPhase {
    if (record.runId) return "fulfilled";
    if (now >= record.lapsesAt) return "lapsed";
    return record.acknowledgedAt ? "acknowledged" : "outstanding";
  }

  private stateOf(record: AgentRunRequest): AgentRunRequestState {
    const phase = this.phaseOf(record);
    return {
      testId: record.testId,
      phase,
      requestedAt: record.requestedAt,
      lapsesAt: isAgentRunRequestInFlight(phase) ? record.lapsesAt : null,
      acknowledgedAt: record.acknowledgedAt,
      runId: record.runId,
    };
  }

  /** Drop finished requests once nobody could still be waiting to read their outcome. */
  private forgetStaleRequests(): void {
    const now = Date.now();
    for (const [key, record] of this.runRequests) {
      if (isAgentRunRequestInFlight(this.phaseOf(record, now))) continue;
      if (now - record.lapsesAt > REQUEST_RETAIN_MS) this.runRequests.delete(key);
    }
  }


  /** The owner's most recently connected helper chat, or undefined when none is listening. */
  private newestConnected(ownerId: string): BridgeChat | undefined {
    let best: BridgeChat | undefined;
    for (const chat of this.chats.values()) {
      if (chat.ownerId !== ownerId || !chat.helperConnected) continue;
      if (!best || (chat.helperConnectedAt ?? 0) > (best.helperConnectedAt ?? 0)) best = chat;
    }
    return best;
  }

  private setHelperConnected(chat: BridgeChat, connected: boolean): void {
    if (chat.helperConnected === connected) return;
    chat.helperConnected = connected;
    chat.helperConnectedAt = connected ? Date.now() : null;
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
