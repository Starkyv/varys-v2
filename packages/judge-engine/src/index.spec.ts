import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VisionJudgeProvider,
  buildJudge,
  createAnthropicTransport,
  createJudgeFromEnv,
  createOpenAICompatibleTransport,
  FakeJudgeProvider,
  GEMINI_OPENAI_BASE,
  JudgeTransportError,
  JUDGE_TOOL_NAME,
  JUDGE_TOOL_SCHEMA,
  ASSERTION_JUDGE_SYSTEM,
  ASSERTION_JUDGE_TOOL_SCHEMA,
  buildAssertionJudgePrompt,
  buildRepairJustificationPrompt,
  judgeAssertion,
  judgeRepairJustification,
  REPAIR_JUSTIFICATION_SYSTEM,
  REPAIR_JUSTIFICATION_TOOL_SCHEMA,
  type JudgeInput,
  type VisionJudgeRequest,
  type VisionJudgeTransport,
} from "./index";

const input: JudgeInput = {
  baseline: Buffer.from("baseline-png"),
  current: Buffer.from("current-png"),
  prompt: "is the current brief broken vs the baseline?",
};

describe("FakeJudgeProvider", () => {
  it("returns a fixed result", async () => {
    const p = new FakeJudgeProvider({ verdict: "pass", reasoning: "looks fine" });
    expect(await p.judge(input)).toEqual({ verdict: "pass", reasoning: "looks fine" });
  });

  it("walks an array and clamps to the last entry", async () => {
    const p = new FakeJudgeProvider([
      { verdict: "fail", reasoning: "empty" },
      { verdict: "pass", reasoning: "recovered" },
    ]);
    expect((await p.judge(input)).verdict).toBe("fail");
    expect((await p.judge(input)).verdict).toBe("pass");
    expect((await p.judge(input)).verdict).toBe("pass"); // clamped
  });

  it("supports a function that can throw to exercise the error path", async () => {
    const p = new FakeJudgeProvider(() => {
      throw new Error("model down");
    });
    await expect(p.judge(input)).rejects.toThrow("model down");
  });
});

describe("VisionJudgeProvider", () => {
  function transportReturning(raw: unknown): { transport: VisionJudgeTransport; calls: VisionJudgeRequest[] } {
    const calls: VisionJudgeRequest[] = [];
    return {
      calls,
      transport: {
        invoke: async (req) => {
          calls.push(req);
          return raw;
        },
      },
    };
  }

  it("assembles the request: baseline first, current second, forced tool + prompt in the text", async () => {
    const { transport, calls } = transportReturning({ verdict: "pass", reasoning: "ok" });
    const p = new VisionJudgeProvider({ model: "test-model", transport });

    const result = await p.judge(input);

    expect(result).toEqual({ verdict: "pass", reasoning: "ok" });
    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.model).toBe("test-model");
    expect(req.images.map((i) => i.png.toString())).toEqual(["baseline-png", "current-png"]);
    expect(req.images[0].label).toMatch(/baseline/i);
    expect(req.images[1].label).toMatch(/current/i);
    expect(req.toolName).toBe(JUDGE_TOOL_NAME);
    expect(req.toolSchema).toBe(JUDGE_TOOL_SCHEMA);
    expect(req.userText).toContain(input.prompt);
  });

  it("throws (never fabricates) on malformed model output", async () => {
    const { transport } = transportReturning({ verdict: "maybe", reasoning: "" });
    const p = new VisionJudgeProvider({ model: "m", transport, maxRetries: 0 });
    await expect(p.judge(input)).rejects.toThrow(/malformed|attempt/i);
  });

  it("retries on transport error and succeeds on a later attempt", async () => {
    let n = 0;
    const transport: VisionJudgeTransport = {
      invoke: async () => {
        n += 1;
        if (n < 3) throw new Error("transient");
        return { verdict: "fail", reasoning: "blank region" };
      },
    };
    const p = new VisionJudgeProvider({ model: "m", transport, maxRetries: 2 });
    expect(await p.judge(input)).toEqual({ verdict: "fail", reasoning: "blank region" });
    expect(n).toBe(3);
  });

  it("throws after exhausting retries", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("always down");
    });
    const p = new VisionJudgeProvider({ model: "m", transport: { invoke }, maxRetries: 2 });
    await expect(p.judge(input)).rejects.toThrow(/3 attempt/);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("aborts and fails a call that exceeds the timeout", async () => {
    const transport: VisionJudgeTransport = {
      invoke: (req) =>
        new Promise((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(req.signal?.reason ?? new Error("aborted")));
        }),
    };
    const p = new VisionJudgeProvider({ model: "m", transport, timeoutMs: 10, maxRetries: 0 });
    await expect(p.judge(input)).rejects.toThrow(/timed out|attempt/i);
  });

  it("hard-times-out a transport that IGNORES the abort signal and never settles", async () => {
    // Simulates a hung provider (request accepted, then no response, signal ignored). The
    // Promise.race hard timeout must still bound it — otherwise the whole run hangs.
    const transport: VisionJudgeTransport = { invoke: () => new Promise(() => {}) };
    const p = new VisionJudgeProvider({ model: "m", transport, timeoutMs: 20, maxRetries: 0 });
    await expect(p.judge(input)).rejects.toThrow(/timed out|attempt/i);
  });

  it("retries a transient error (503 overloaded) and then succeeds", async () => {
    let n = 0;
    const transport: VisionJudgeTransport = {
      invoke: async () => {
        n += 1;
        if (n === 1) throw new JudgeTransportError(503, "model overloaded, try again later");
        return { verdict: "pass", reasoning: "ok on retry" };
      },
    };
    const p = new VisionJudgeProvider({ model: "m", transport, maxRetries: 2 });
    expect(await p.judge(input)).toEqual({ verdict: "pass", reasoning: "ok on retry" });
    expect(n).toBe(2); // one retry after the transient 503
  });

  it("fails FAST on a terminal error (400) without wasting retries", async () => {
    const invoke = vi.fn(async () => {
      throw new JudgeTransportError(400, "invalid request");
    });
    const p = new VisionJudgeProvider({ model: "m", transport: { invoke }, maxRetries: 2 });
    await expect(p.judge(input)).rejects.toThrow(/1 attempt|400/);
    expect(invoke).toHaveBeenCalledTimes(1); // did not retry a client error
  });
});

describe("createAnthropicTransport (contract)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(response: unknown, ok = true, status = 200) {
    const fetchMock = vi.fn(async () => ({
      ok,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const req: VisionJudgeRequest = {
    model: "claude-test",
    system: "system prompt",
    userText: "compare these",
    images: [
      { label: "BASELINE", png: Buffer.from("base") },
      { label: "CURRENT", png: Buffer.from("curr") },
    ],
    toolName: JUDGE_TOOL_NAME,
    toolSchema: JUDGE_TOOL_SCHEMA,
  };

  it("posts a forced-tool vision request and returns the tool-call args", async () => {
    const fetchMock = stubFetch({
      content: [{ type: "tool_use", name: JUDGE_TOOL_NAME, input: { verdict: "pass", reasoning: "ok" } }],
    });
    const transport = createAnthropicTransport({ apiKey: "sk-test" });

    const out = await transport.invoke(req);

    expect(out).toEqual({ verdict: "pass", reasoning: "ok" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBeTruthy();
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-test");
    expect(body.temperature).toBeUndefined(); // omitted by default (newer models reject it)
    expect(body.tool_choice).toEqual({ type: "tool", name: JUDGE_TOOL_NAME });
    // Two base64 PNG image blocks, baseline before current.
    const images = body.messages[0].content.filter((b: { type: string }) => b.type === "image");
    expect(images).toHaveLength(2);
    expect(images[0].source).toMatchObject({ type: "base64", media_type: "image/png" });
    expect(Buffer.from(images[0].source.data, "base64").toString()).toBe("base");
  });

  it("includes temperature only when explicitly configured", async () => {
    const fetchMock = stubFetch({
      content: [{ type: "tool_use", name: JUDGE_TOOL_NAME, input: { verdict: "pass", reasoning: "ok" } }],
    });
    const transport = createAnthropicTransport({ apiKey: "sk-test", temperature: 0 });
    await transport.invoke(req);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.temperature).toBe(0);
  });

  it("throws on a non-2xx response (so the provider retries / fails safe)", async () => {
    stubFetch({ error: "rate limited" }, false, 429);
    const transport = createAnthropicTransport({ apiKey: "sk-test" });
    await expect(transport.invoke(req)).rejects.toThrow(/429/);
  });

  it("throws when the response has no tool_use block", async () => {
    stubFetch({ content: [{ type: "text", text: "no tool here" }] });
    const transport = createAnthropicTransport({ apiKey: "sk-test" });
    await expect(transport.invoke(req)).rejects.toThrow(/no tool_use/);
  });

  it("end-to-end: provider parses a fetched tool_use into a verdict", async () => {
    stubFetch({
      content: [{ type: "tool_use", name: JUDGE_TOOL_NAME, input: { verdict: "fail", reasoning: "blank" } }],
    });
    const p = new VisionJudgeProvider({
      model: "claude-test",
      transport: createAnthropicTransport({ apiKey: "sk-test" }),
    });
    expect(await p.judge(input)).toEqual({ verdict: "fail", reasoning: "blank" });
  });
});

describe("createOpenAICompatibleTransport (contract)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const req: VisionJudgeRequest = {
    model: "gemini-2.0-flash",
    system: "system prompt",
    userText: "compare these",
    images: [
      { label: "BASELINE", png: Buffer.from("base") },
      { label: "CURRENT", png: Buffer.from("curr") },
    ],
    toolName: JUDGE_TOOL_NAME,
    toolSchema: JUDGE_TOOL_SCHEMA,
  };

  function stubFetch(response: unknown, ok = true, status = 200) {
    const fetchMock = vi.fn(async () => ({
      ok,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts image_url blocks + json_schema and parses the JSON content", async () => {
    const fetchMock = stubFetch({
      choices: [{ message: { content: JSON.stringify({ verdict: "pass", reasoning: "healthy" }) } }],
    });
    const transport = createOpenAICompatibleTransport({ apiKey: "k", baseUrl: `${GEMINI_OPENAI_BASE}/` });

    const out = await transport.invoke(req);

    expect(out).toEqual({ verdict: "pass", reasoning: "healthy" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GEMINI_OPENAI_BASE}/chat/completions`); // trailing slash trimmed
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gemini-2.0-flash");
    expect(body.response_format.type).toBe("json_schema");
    const imgs = body.messages[1].content.filter((b: { type: string }) => b.type === "image_url");
    expect(imgs).toHaveLength(2);
    expect(imgs[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("strips ```json fences before parsing", async () => {
    stubFetch({
      choices: [{ message: { content: "```json\n{\"verdict\":\"fail\",\"reasoning\":\"blank\"}\n```" } }],
    });
    const transport = createOpenAICompatibleTransport({ apiKey: "k", baseUrl: GEMINI_OPENAI_BASE });
    expect(await transport.invoke(req)).toEqual({ verdict: "fail", reasoning: "blank" });
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ error: "quota" }, false, 429);
    const transport = createOpenAICompatibleTransport({ apiKey: "k", baseUrl: GEMINI_OPENAI_BASE });
    await expect(transport.invoke(req)).rejects.toThrow(/429/);
  });
});

describe("buildJudge (provider selection)", () => {
  it("returns undefined when key or model is missing", () => {
    expect(buildJudge(undefined)).toBeUndefined();
    expect(buildJudge({ provider: "gemini", model: "m" })).toBeUndefined(); // no key
    expect(buildJudge({ provider: "gemini", apiKey: "k" })).toBeUndefined(); // no model
  });

  it("builds a provider for anthropic and gemini", () => {
    expect(buildJudge({ provider: "anthropic", apiKey: "k", model: "claude" })).toBeInstanceOf(VisionJudgeProvider);
    expect(buildJudge({ provider: "gemini", apiKey: "k", model: "gemini-2.0-flash" })).toBeInstanceOf(VisionJudgeProvider);
  });

  it("requires a baseUrl for a custom openai provider", () => {
    expect(buildJudge({ provider: "openai", apiKey: "k", model: "m" })).toBeUndefined();
    expect(buildJudge({ provider: "openai", apiKey: "k", model: "m", baseUrl: "http://localhost:11434/v1" })).toBeInstanceOf(
      VisionJudgeProvider,
    );
  });
});

describe("createJudgeFromEnv", () => {
  it("returns undefined when unconfigured", () => {
    expect(createJudgeFromEnv({})).toBeUndefined();
    expect(createJudgeFromEnv({ VARYS_JUDGE_MODEL: "m" })).toBeUndefined(); // no key
    expect(createJudgeFromEnv({ VARYS_JUDGE_PROVIDER: "other", VARYS_JUDGE_API_KEY: "k", VARYS_JUDGE_MODEL: "m" })).toBeUndefined();
  });

  it("builds an Anthropic provider when key + model are present", () => {
    const judge = createJudgeFromEnv({ VARYS_JUDGE_API_KEY: "k", VARYS_JUDGE_MODEL: "m" });
    expect(judge).toBeInstanceOf(VisionJudgeProvider);
  });
});

/**
 * The repair-justification gate (Slice 19, slice 05). Two things are worth pinning here: that the
 * gate genuinely rides the SAME provider (so a scripted/fake judge and a thrown transport error
 * behave identically for it), and that everything the rubric weighs actually reaches the model —
 * a prompt that silently drops the Brief or the before/after signals would still return verdicts,
 * just uninformed ones.
 */
describe("repair-justification gate", () => {
  const claim = {
    testName: "Save the report",
    brief: "Saving must work: the primary save control commits the changes.",
    failingStep: 'click "Save changes"',
    runError: "locator not found",
    change: 'data-testid: "save-btn" → "commit-btn"',
    summary: "Re-pinned to the Commit changes button.",
    justification: "Same control, relabelled — it still commits the form.",
  };

  it("sends NO images, its own rubric, and its own verdict descriptions", async () => {
    const calls: VisionJudgeRequest[] = [];
    const p = new VisionJudgeProvider({
      model: "m",
      transport: {
        invoke: async (req) => {
          calls.push(req);
          return { verdict: "pass", reasoning: "same control" };
        },
      },
    });

    const result = await judgeRepairJustification(p, claim);

    expect(result).toEqual({ verdict: "pass", reasoning: "same control" });
    expect(calls[0].images).toEqual([]);
    // The default rubric is the VISUAL one — grading prose against it would be the wrong question.
    expect(calls[0].system).toBe(REPAIR_JUSTIFICATION_SYSTEM);
    expect(calls[0].toolSchema).toBe(REPAIR_JUSTIFICATION_TOOL_SCHEMA);
    // No images means no screenshot vocabulary wrapped around the prompt either.
    expect(calls[0].userText).not.toContain("BASELINE");
  });

  it("puts every piece of evidence the rubric weighs into the prompt", async () => {
    const text = buildRepairJustificationPrompt(claim);
    for (const fragment of [
      claim.brief,
      claim.failingStep,
      claim.runError,
      claim.change,
      claim.summary,
      claim.justification,
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it("says so plainly when the Brief is missing, rather than omitting the section", async () => {
    // A prompt that just leaves the heading out reads as "there was nothing to say"; the rubric
    // fails an absent Brief, so the absence has to be visible to it.
    const text = buildRepairJustificationPrompt({ ...claim, brief: null });
    expect(text).toContain("BRIEF");
    expect(text).toContain("(none given)");
  });

  it("throws rather than passing when the judge cannot answer", async () => {
    const p = new VisionJudgeProvider({
      model: "m",
      maxRetries: 0,
      transport: {
        invoke: async () => {
          throw new JudgeTransportError(500, "overloaded");
        },
      },
    });
    // The caller's contract: a throw is "abandon the repair", never "apply it".
    await expect(judgeRepairJustification(p, claim)).rejects.toThrow(/attempt|overloaded/i);
  });

  it("is exercised by the fake provider like any other judgement", async () => {
    const p = new FakeJudgeProvider({ verdict: "fail", reasoning: "different control" });
    expect(await judgeRepairJustification(p, claim)).toEqual({
      verdict: "fail",
      reasoning: "different control",
    });
  });

  it("keeps the rubric's tie-break in the tool schema, so a model reading only that still fails closed", () => {
    expect(REPAIR_JUSTIFICATION_TOOL_SCHEMA.properties.verdict.description).toMatch(/in doubt, fail/i);
  });
});

/**
 * The assertion fallback (Slice 19, slice 11).
 *
 * The seam is the same one the `context` checkpoint and the justification gate already ride, which
 * is the entire argument for reusing it: a fake provider covers it for free, and a thrown transport
 * error is already "not a pass". What is new here is the RUBRIC, and specifically its refusal to do
 * arithmetic — a judge summing a 40-row column and answering confidently is the failure mode this
 * whole fallback has to be prevented from becoming.
 */
describe("the assertion fallback", () => {
  const check = "The revenue chart looks reasonable";
  const screenshot = Buffer.from("page-png");

  it("sends the author's own sentence, the page, and the assertion rubric", async () => {
    let seen: JudgeInput | null = null;
    const p = new FakeJudgeProvider((i) => {
      seen = i;
      return { verdict: "pass", reasoning: "bars render, axis labelled" };
    });
    expect(await judgeAssertion(p, { check, screenshot })).toEqual({
      verdict: "pass",
      reasoning: "bars render, axis labelled",
    });
    const sent = seen as unknown as JudgeInput;
    // The page as the run left it — and NO baseline: there is nothing to compare against, and a
    // rubric that thought there was would grade the wrong question.
    expect(sent.current).toBe(screenshot);
    expect(sent.baseline).toBeUndefined();
    // The author's wording travels verbatim; a paraphrase would check something they never wrote.
    expect(sent.prompt).toContain(check);
    expect(sent.system).toBe(ASSERTION_JUDGE_SYSTEM);
    expect(sent.toolSchema).toBe(ASSERTION_JUDGE_TOOL_SCHEMA);
  });

  it("propagates a fail verdict with its reasoning", async () => {
    const p = new FakeJudgeProvider({ verdict: "fail", reasoning: "the chart area is empty" });
    expect(await judgeAssertion(p, { check, screenshot })).toEqual({
      verdict: "fail",
      reasoning: "the chart area is empty",
    });
  });

  it("THROWS rather than answering when the transport fails", async () => {
    // The caller's contract, and the reason this test exists: a throw is "nothing was checked",
    // which the runner records as needs-review. A provider that swallowed this into a pass would
    // turn every model outage into a silent green across the whole corpus.
    const p = new FakeJudgeProvider(() => {
      throw new JudgeTransportError(429, "rate limited");
    });
    await expect(judgeAssertion(p, { check, screenshot })).rejects.toThrow(/rate limited/i);
  });

  it("refuses quantitative work in the rubric AND in the tool schema", () => {
    // Both, deliberately: a model that reads only the forced-tool definition still declines, and
    // a confident wrong PASS on an arithmetic claim is worse than no check at all.
    expect(ASSERTION_JUDGE_SYSTEM).toMatch(/must NOT read exact figures/i);
    expect(ASSERTION_JUDGE_SYSTEM).toMatch(/pinned/i);
    expect(ASSERTION_JUDGE_TOOL_SCHEMA.properties.verdict.description).toMatch(/arithmetic/i);
    expect(ASSERTION_JUDGE_TOOL_SCHEMA.properties.verdict.description).toMatch(/pinned/i);
    // …and it fails closed when the screenshot does not settle the question.
    expect(ASSERTION_JUDGE_SYSTEM).toMatch(/does not show enough to decide/i);
  });

  it("asks about one claim only, and never about a previous version", () => {
    const prompt = buildAssertionJudgePrompt("  The legend is readable  ");
    expect(prompt).toContain("The legend is readable");
    // Trimmed, so an author's stray whitespace does not reach the model as content.
    expect(prompt).not.toContain("  The legend");
    expect(ASSERTION_JUDGE_SYSTEM).toMatch(/have not been shown one/i);
  });
});
