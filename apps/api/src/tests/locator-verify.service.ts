import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { environments, testVersions } from "@varys/db";
import type { LocatorVerifyRequest, LocatorVerifyResult } from "@varys/review-contract";
import {
  type EnvCookie,
  type EnvironmentProfile,
  LocatorVerifyAbortedError,
  verifyLocatorAtStep,
} from "@varys/runner";
import type { TestDefinition } from "@varys/step-schema";
import { desc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { applyFingerprintPatch } from "../fingerprint-patch";

/**
 * The live locator-verify probe (Slice 16.3a). Given a CANDIDATE (unsaved) locator edit for
 * one step, it merges it onto the step's fingerprint, loads the chosen environment's
 * values/secrets/cookies, and runs an artifact-free PARTIAL REPLAY (in `@varys/runner`,
 * sharing the Run's drive primitive + the real matcher) to report whether the locator
 * resolves at that step. Nothing is persisted. Single-flight per test: a new probe
 * supersedes any in-flight one for the same test.
 */
@Injectable()
export class LocatorVerifyService {
  // Per-test cancel tokens — a new verify flips the previous one's `aborted`, which the
  // drive checks between steps to bail out (cooperative single-flight).
  private readonly inflight = new Map<string, { aborted: boolean }>();

  constructor(@Inject(DB) private readonly db: Db) {}

  async verify(testId: string, req: LocatorVerifyRequest): Promise<LocatorVerifyResult> {
    const [row] = await this.db
      .select({ definition: testVersions.definition })
      .from(testVersions)
      .where(eq(testVersions.testId, testId))
      .orderBy(desc(testVersions.version))
      .limit(1);
    if (!row) throw new NotFoundException(`Test ${testId} not found`);
    const def = row.definition as TestDefinition;

    const step = def.steps[req.stepIndex];
    if (!step) throw new BadRequestException(`Step ${req.stepIndex} is out of range`);
    const baseFp = "target" in step ? step.target : undefined;
    if (!baseFp) throw new BadRequestException("This step has no element locator to verify");

    // The candidate is the saved fingerprint with the unsaved edit merged in.
    const candidate = applyFingerprintPatch(baseFp, req.target);

    // Resolve the environment (for {{token}} resolution + cookies); env-less when omitted.
    let profile: EnvironmentProfile | null = null;
    let cookies: EnvCookie[] = [];
    if (req.environmentId) {
      const [env] = await this.db
        .select({
          values: environments.values,
          secrets: environments.secrets,
          cookies: environments.cookies,
        })
        .from(environments)
        .where(eq(environments.id, req.environmentId))
        .limit(1);
      if (!env) throw new NotFoundException(`Environment ${req.environmentId} not found`);
      profile = {
        values: (env.values ?? {}) as Record<string, string>,
        secrets: (env.secrets ?? {}) as Record<string, string>,
      };
      cookies = (env.cookies ?? []) as EnvCookie[];
    }

    // Supersede any in-flight verify for this test, then register ourselves.
    const prev = this.inflight.get(testId);
    if (prev) prev.aborted = true;
    const token = { aborted: false };
    this.inflight.set(testId, token);

    try {
      return await verifyLocatorAtStep({
        definition: def,
        stepIndex: req.stepIndex,
        candidate,
        profile,
        cookies,
        shouldAbort: () => token.aborted,
      });
    } catch (err) {
      if (err instanceof LocatorVerifyAbortedError) {
        throw new ConflictException("Verify superseded by a newer request");
      }
      throw err;
    } finally {
      if (this.inflight.get(testId) === token) this.inflight.delete(testId);
    }
  }
}
