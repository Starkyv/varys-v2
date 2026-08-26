import { createHash, randomBytes } from "node:crypto";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AgentCredentialStatus,
  AgentCredentialSummary,
  CreateAgentCredentialRequest,
  CreatedAgentCredential,
} from "@varys/review-contract";
import { desc, eq } from "drizzle-orm";
import { agentCredentials } from "../db/schema";
import { DB, type Db } from "../db/db.module";

/**
 * The prefix every Repair Agent token carries. It is what routes a bearer token to THIS issuer
 * instead of the OAuth one in `McpAuthService` — so a human's OAuth token never touches this
 * code path, and this token never touches better-auth's.
 */
export const AGENT_TOKEN_PREFIX = "varys_agent_";

/** Default expiry when the admin doesn't pick one. Deliberately short: ADR-0005 makes expiry
 *  part of the safeguard, and a drainer's credential is cheap to re-issue. */
const DEFAULT_EXPIRY_DAYS = 30;
const MAX_EXPIRY_DAYS = 365;

/** What a valid credential resolves to — the makings of an `agent:…` principal. */
export interface ResolvedAgentCredential {
  id: string;
  label: string;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Repair Agent credentials (Slice 19, slice 02 — ADR-0005): provisioning, listing, revocation,
 * and the resolution step `/mcp` performs on every request.
 *
 * The credential is a SECOND ISSUER, not an exemption: `resolve` yields an identity, and the
 * caller turns it into a real `McpPrincipal`, so every ownership check and attribution write
 * downstream keeps working. Its safeguard is scope (enforced in the MCP controller) plus expiry,
 * revocation and a visible `last_used_at` — enforced here.
 *
 * Only the token's SHA-256 is stored. That makes the plaintext unrecoverable after provisioning,
 * which is also why the management surface shows a 4-character hint rather than the secret.
 */
@Injectable()
export class AgentCredentialsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Provision a credential and return its token ONCE. There is deliberately no endpoint that
   * re-reads it: a token an admin can fetch again is a token a compromised session can fetch.
   */
  async create(
    body: CreateAgentCredentialRequest,
    createdBy: string,
  ): Promise<CreatedAgentCredential> {
    const label = (body?.label ?? "").trim();
    if (!label) throw new BadRequestException("a label is required");

    const days = body?.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
    if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRY_DAYS) {
      throw new BadRequestException(`expiresInDays must be between 1 and ${MAX_EXPIRY_DAYS}`);
    }

    const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const [row] = await this.db
      .insert(agentCredentials)
      .values({
        label,
        tokenHash: hash(token),
        tokenHint: token.slice(-4),
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
        createdBy,
      })
      .returning();

    return { credential: this.toSummary(row), token };
  }

  /** Every credential ever provisioned, newest first — revoked and expired ones included, since
   *  "what machine access exists (and did exist)" is the question this surface answers. */
  async list(): Promise<AgentCredentialSummary[]> {
    const rows = await this.db
      .select()
      .from(agentCredentials)
      .orderBy(desc(agentCredentials.createdAt));
    return rows.map((r) => this.toSummary(r));
  }

  /**
   * Revoke a credential — effective on the very next request, because `resolve` reads
   * `revoked_at` per presentation rather than caching anything. Idempotent: revoking twice keeps
   * the original timestamp instead of erroring, so a panicked double-click is harmless.
   */
  async revoke(id: string): Promise<AgentCredentialSummary> {
    const [row] = await this.db
      .select()
      .from(agentCredentials)
      .where(eq(agentCredentials.id, id))
      .limit(1);
    if (!row) throw new NotFoundException(`Agent credential ${id} not found`);
    if (row.revokedAt) return this.toSummary(row);

    const [updated] = await this.db
      .update(agentCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(agentCredentials.id, id))
      .returning();
    return this.toSummary(updated);
  }

  /**
   * Resolve a presented token, or `null` if it is unknown, malformed, revoked or expired.
   *
   * ALL of those collapse to the same `null` on purpose: the caller turns it into the identical
   * 401 an unknown OAuth token gets, so a probe cannot learn whether a token was ever real.
   *
   * `last_used_at` is written on every success — it is the only evidence an admin has that a
   * credential is still live, so it must not be sampled or debounced.
   */
  async resolve(token: string): Promise<ResolvedAgentCredential | null> {
    if (!token?.startsWith(AGENT_TOKEN_PREFIX)) return null;

    const [row] = await this.db
      .select()
      .from(agentCredentials)
      .where(eq(agentCredentials.tokenHash, hash(token)))
      .limit(1);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;

    await this.db
      .update(agentCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentCredentials.id, row.id));

    return { id: row.id, label: row.label };
  }

  private toSummary(row: typeof agentCredentials.$inferSelect): AgentCredentialSummary {
    let status: AgentCredentialStatus = "active";
    if (row.revokedAt) status = "revoked";
    else if (row.expiresAt.getTime() <= Date.now()) status = "expired";
    return {
      id: row.id,
      label: row.label,
      tokenHint: row.tokenHint,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      status,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
