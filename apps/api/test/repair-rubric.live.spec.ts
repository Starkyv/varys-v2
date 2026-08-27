import {
  buildJudge,
  judgeRepairJustification,
  type JudgeProviderName,
  type RepairJustificationInput,
} from "@varys/judge-engine";
import { describe, expect, it } from "vitest";

/**
 * The justification rubric, against a REAL model (Slice 19, slice 05).
 *
 * Everything else about the gate is pinned with a scripted judge, because the verdicts are the
 * inputs there. This file is the one thing a scripted judge can say nothing about: whether the
 * WORDING of `REPAIR_JUSTIFICATION_SYSTEM` actually catches what it was written to catch. A rubric
 * that always says yes is worse than no gate at all — it looks like one — and only a live call can
 * tell you which you have.
 *
 * Opt-in: skipped unless a judge is configured (`VARYS_JUDGE_API_KEY` + `VARYS_JUDGE_MODEL`, plus
 * `VARYS_JUDGE_PROVIDER` for a non-Anthropic one). Run it after ANY edit to the rubric:
 *
 *   VARYS_JUDGE_PROVIDER=gemini VARYS_JUDGE_API_KEY=... VARYS_JUDGE_MODEL=gemini-2.0-flash \
 *     npx vitest run test/repair-rubric.live.spec.ts
 *
 * It is deliberately not part of the gate's own suite: this needs a network and a key, and a CI
 * run that silently skipped it should not look like the gate went untested.
 */
const judge = buildJudge({
  provider: (process.env.VARYS_JUDGE_PROVIDER ?? "anthropic") as JudgeProviderName,
  apiKey: process.env.VARYS_JUDGE_API_KEY ?? "",
  model: process.env.VARYS_JUDGE_MODEL ?? "",
  baseUrl: process.env.VARYS_JUDGE_BASE_URL,
});

const BRIEF =
  "The reports page must let an analyst narrow the data: choosing a date range and a segment, " +
  "then applying that filter, updates the table to match.";

const base: RepairJustificationInput = {
  testName: "Reports — apply a filter",
  brief: BRIEF,
  failingStep: 'click "Apply filter"',
  runError: 'locator not found: no element matched the recorded fingerprint for "Apply filter"',
  change: "",
  summary: "",
  justification: "",
};

describe.skipIf(!judge)("the justification rubric, against a real judge", () => {
  it("ACCEPTS a genuine rename of the same control", async () => {
    const verdict = await judgeRepairJustification(judge!, {
      ...base,
      change:
        'Step 4 — click "Apply filter"\n' +
        '  · accessible name: "Apply filter" → "Apply filters"\n' +
        '  · data-testid: "apply-filter" → "filters-apply"\n' +
        '  · visible text: "Apply filter" → "Apply filters"',
      summary:
        'Re-pinned the click to the same button in the filter bar; its label and test id were changed by the redesign.',
      justification:
        'The Brief requires that "applying that filter updates the table to match". This is that ' +
        "same button: it is still the only submit control inside the filter bar, still sits after " +
        "the date-range and segment inputs, and still applies the filter. The redesign renamed it " +
        'from "Apply filter" to "Apply filters" and changed its test id from apply-filter to ' +
        "filters-apply; nothing about what it does changed.",
    });
    expect(verdict.verdict).toBe("pass");
  }, 120_000);

  it("REJECTS re-pinning to a different control when the original was removed", async () => {
    // The canonical wrong repair: "Apply filter" was DELETED by a deploy, and the agent found a
    // plausible "Refresh" button beside where it used to be. The new locator resolves perfectly.
    const verdict = await judgeRepairJustification(judge!, {
      ...base,
      change:
        'Step 4 — click "Apply filter"\n' +
        '  · accessible name: "Apply filter" → "Refresh"\n' +
        '  · data-testid: "apply-filter" → "refresh-table"\n' +
        '  · visible text: "Apply filter" → "Refresh"',
      summary: 'Re-pinned the click to the "Refresh" button in the toolbar.',
      justification:
        'The Brief requires that the filter is applied and the table updates. The "Apply filter" ' +
        'button no longer exists on the page, but the "Refresh" button re-reads the table with the ' +
        "current inputs, which achieves the same outcome, so it satisfies that clause. It is the " +
        "closest match on the page and the locator resolves cleanly.",
    });
    expect(verdict.verdict).toBe("fail");
  }, 120_000);
});
