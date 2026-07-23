import { z } from "zod";

/**
 * Judge engine — the `context` comparison for screenshot checkpoints.
 *
 * Where pixel checkpoints run `diffPng(baseline, actual)`, a `context` checkpoint sends the
 * approved **baseline** + the **current** screenshot + an author-written **prompt** to an LLM
 * that returns `pass | fail` + one-line reasoning. This is for non-deterministic, LLM-generated
 * content (Briefs, Wisdom) whose pixels legitimately change every run.
 *
 * The call is one-shot and stateless: two images + one prompt in, a structured verdict out. No
 * tool-use, no follow-up questions, image-only. It sits behind the swappable {@link JudgeProvider}
 * seam so the concrete model (Anthropic vision today, an agent later) is a composition-root choice.
 *
 * This package is pure and network-free: {@link VisionJudgeProvider} delegates the actual model
 * call to an injected {@link VisionJudgeTransport}, so all judge semantics (prompt assembly,
 * retry/timeout, structured-output parsing, pass/fail mapping) are unit-testable without a network.
 */

export type JudgeVerdict = "pass" | "fail";

export interface JudgeInput {
  /** The approved reference screenshot (PNG bytes). */
  baseline: Buffer;
  /** This run's screenshot (PNG bytes). */
  current: Buffer;
  /** The author-written instruction/checklist the judge follows. */
  prompt: string;
}

export interface JudgeResult {
  verdict: JudgeVerdict;
  /** One-line rationale, shown to the reviewer beside both images. */
  reasoning: string;
}

/**
 * The comparison strategy for a `context` checkpoint. A provider either returns a
 * {@link JudgeResult} or **throws** — it must never swallow a model/transport error into a `pass`.
 * The caller (the runner) maps a thrown error to `needs-review`, never a silent green.
 */
export interface JudgeProvider {
  judge(input: JudgeInput): Promise<JudgeResult>;
}

/** Validates the structured output a provider must produce (`{ verdict, reasoning }`). */
export const judgeResultSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  reasoning: z.string().min(1),
});

/**
 * The JSON schema the model's forced-tool call must satisfy — exported so the real transport
 * (Phase 5) and the parser agree on one shape.
 */
export const JUDGE_TOOL_NAME = "report_verdict";
export const JUDGE_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string",
      enum: ["pass", "fail"],
      description:
        "pass = the CURRENT screenshot is a healthy instance of the same content as the BASELINE (ignoring that words/numbers/charts legitimately differ). fail = the current one is broken, empty, error-state, or structurally degraded vs the baseline.",
    },
    reasoning: {
      type: "string",
      description: "One concise sentence explaining the verdict, for a human reviewer.",
    },
  },
  required: ["verdict", "reasoning"],
} as const;

/**
 * A scripted provider for tests — returns fixed verdicts (or runs a function, which may throw to
 * exercise the error path) without any model call. Never used in production.
 */
export class FakeJudgeProvider implements JudgeProvider {
  private index = 0;
  constructor(
    private readonly script:
      | JudgeResult
      | JudgeResult[]
      | ((input: JudgeInput) => JudgeResult | Promise<JudgeResult>),
  ) {}

  async judge(input: JudgeInput): Promise<JudgeResult> {
    if (typeof this.script === "function") return this.script(input);
    if (Array.isArray(this.script)) {
      // Clamp to the last entry so an over-long run keeps returning the final scripted verdict.
      const r = this.script[Math.min(this.index, this.script.length - 1)];
      this.index += 1;
      return r;
    }
    return this.script;
  }
}

/** An image handed to the transport, labelled so the model knows which is the reference. */
export interface JudgeImage {
  label: string;
  png: Buffer;
}

/** The assembled, provider-agnostic request the {@link VisionJudgeTransport} executes. */
export interface VisionJudgeRequest {
  model: string;
  system: string;
  /** The full user-turn text (author prompt wrapped in the judge rubric + response contract). */
  userText: string;
  /** Baseline then current, each labelled. */
  images: JudgeImage[];
  /** Forced-tool name + schema the model must call to answer. */
  toolName: string;
  toolSchema: object;
  /** Aborts the in-flight call on timeout. */
  signal?: AbortSignal;
}

/**
 * The one network-touching seam: given an assembled {@link VisionJudgeRequest}, return the raw
 * arguments the model passed to the forced tool (validated by the provider). The real
 * Anthropic-SDK-backed implementation is wired in the composition root (Phase 5); tests inject a
 * fake.
 */
export interface VisionJudgeTransport {
  invoke(req: VisionJudgeRequest): Promise<unknown>;
}

export interface VisionJudgeProviderOptions {
  model: string;
  transport: VisionJudgeTransport;
  /** Per-call timeout before an attempt is aborted and (maybe) retried. Default 60s. */
  timeoutMs?: number;
  /** Retries AFTER the first attempt. Default 2 (⇒ up to 3 attempts). */
  maxRetries?: number;
  /** Override the system prompt (defaults to {@link DEFAULT_JUDGE_SYSTEM}). */
  system?: string;
}

export const DEFAULT_JUDGE_SYSTEM =
  "You are a visual QA judge for an automated UI test runner. You are shown two screenshots of the " +
  "same UI region: a BASELINE that a human already approved as correct, and the CURRENT capture from " +
  "this test run. The content is AI-generated and legitimately changes every run, so DO NOT fail on " +
  "different wording, numbers, or chart values. Fail ONLY when the CURRENT capture is broken relative " +
  "to the baseline: empty/blank where the baseline had content, an error or loading state, missing " +
  "sections, garbled/overlapping layout, or obviously degraded rendering. Follow the author's " +
  "checklist. Answer by calling the provided tool exactly once.";

function buildUserText(prompt: string): string {
  return (
    `The first image is the BASELINE (approved reference). The second image is the CURRENT capture from this run.\n\n` +
    `Author's checklist / instruction:\n${prompt}\n\n` +
    `Decide whether the CURRENT capture is a healthy instance of the same content as the baseline, ` +
    `ignoring differences that are only in the generated words/numbers/charts. Report a verdict of ` +
    `"pass" or "fail" with one sentence of reasoning.`
  );
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`judge model call timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * A non-2xx response from a judge transport, carrying the HTTP status so the provider can decide
 * whether retrying is worthwhile. **Transient** statuses (rate-limit / overloaded / server errors)
 * are retryable; **client** statuses (auth, bad request, model-not-found) won't fix on retry.
 */
export class JudgeTransportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JudgeTransportError";
  }
  /** 408 timeout · 409 conflict · 429 rate-limit · 5xx (incl. 503 overloaded, 529 Anthropic). */
  get retryable(): boolean {
    return this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

/** Only give up early on a KNOWN-terminal transport error (a client 4xx that isn't a rate-limit).
 *  Everything else — transient HTTP, timeouts, network blips, transient malformed output — is worth
 *  another try. */
function isRetryable(err: unknown): boolean {
  if (err instanceof JudgeTransportError) return err.retryable;
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, capped — gives a spiking/overloaded model a moment to recover
 *  between attempts instead of hammering it instantly. */
function backoffMs(attempt: number): number {
  return Math.min(4000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/**
 * The direct vision-model provider. Owns all judge semantics; delegates only the raw model call to
 * its {@link VisionJudgeTransport}. Runs the model at (transport-configured) temperature 0 and forces
 * structured output via the {@link JUDGE_TOOL_SCHEMA}. Retries on transport error/timeout and throws
 * if every attempt fails or the output can't be validated — never returns a fabricated verdict.
 */
export class VisionJudgeProvider implements JudgeProvider {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly system: string;

  constructor(private readonly opts: VisionJudgeProviderOptions) {
    // Per-checkpoint gate: keep the worst case small. Default 30s × (1 retry ⇒ 2 attempts) = ≤60s,
    // so a hanging/slow provider can't stall a run (a vision call on two small images normally
    // returns in a few seconds). Overridable via VARYS_JUDGE_TIMEOUT_MS / _MAX_RETRIES.
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.system = opts.system ?? DEFAULT_JUDGE_SYSTEM;
  }

  async judge(input: JudgeInput): Promise<JudgeResult> {
    const request = (signal: AbortSignal): VisionJudgeRequest => ({
      model: this.opts.model,
      system: this.system,
      userText: buildUserText(input.prompt),
      images: [
        { label: "BASELINE (approved reference)", png: input.baseline },
        { label: "CURRENT (this run)", png: input.current },
      ],
      toolName: JUDGE_TOOL_NAME,
      toolSchema: JUDGE_TOOL_SCHEMA,
      signal,
    });

    let lastError: unknown;
    let attempts = 0;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      attempts += 1;
      try {
        const raw = await this.invokeWithTimeout(request);
        const parsed = judgeResultSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(`judge returned malformed output: ${parsed.error.message}`);
        }
        return parsed.data;
      } catch (err) {
        lastError = err;
        // Give up immediately on a terminal error (e.g. 401/400/404) — retrying can't fix it.
        // For transient errors (429/503/overloaded/timeout/network), back off and try again.
        if (attempt < this.maxRetries && isRetryable(err)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        break;
      }
    }
    throw new Error(
      `judge failed after ${attempts} attempt(s): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  private async invokeWithTimeout(
    request: (signal: AbortSignal) => VisionJudgeRequest,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A HARD timeout via Promise.race: the attempt rejects at `timeoutMs` even if the transport
    // (or a hung fetch body read) never honors the abort signal. We still fire the abort as a
    // best-effort to free the socket — but correctness no longer depends on it. Without this, a
    // provider that accepts the request then stops responding hangs the whole run indefinitely.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort(new TimeoutError(this.timeoutMs));
        } catch {
          /* best-effort */
        }
        reject(new TimeoutError(this.timeoutMs));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.opts.transport.invoke(request(controller.signal)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export interface AnthropicTransportConfig {
  apiKey: string;
  /** API base, override for a proxy/gateway. Defaults to Anthropic's public endpoint. */
  baseUrl?: string;
  /** `anthropic-version` header. Defaults to a known-good pinned version. */
  anthropicVersion?: string;
  /** Cap on the judge's output tokens (the verdict + one-line reason is tiny). Default 1024. */
  maxTokens?: number;
  /** Sampling temperature. OMITTED by default — newer models reject `temperature` outright, and
   *  the judge's determinism comes from the forced-tool structured output + checklist prompt, not
   *  sampling. Set it (e.g. 0) only for a model that still accepts it. */
  temperature?: number;
}

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";

/**
 * The real, network-touching transport: turns an assembled {@link VisionJudgeRequest} into an
 * Anthropic Messages API call (two base64 PNG image blocks + the prompt text, `temperature: 0`,
 * and a forced tool call so the model must answer with structured `{verdict, reasoning}`), then
 * returns the tool-call arguments for the provider to validate. Uses global `fetch` (no SDK
 * dependency); a non-2xx response or a missing tool call throws (the provider retries / fails safe).
 */
export function createAnthropicTransport(config: AnthropicTransportConfig): VisionJudgeTransport {
  const base = config.baseUrl ?? ANTHROPIC_DEFAULT_BASE;
  const version = config.anthropicVersion ?? ANTHROPIC_DEFAULT_VERSION;
  const maxTokens = config.maxTokens ?? 1024;

  return {
    async invoke(req: VisionJudgeRequest): Promise<unknown> {
      // Interleave a text label before each image so the model knows which is baseline vs current,
      // then the instruction text.
      const content: unknown[] = [];
      for (const img of req.images) {
        content.push({ type: "text", text: img.label });
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: img.png.toString("base64") },
        });
      }
      content.push({ type: "text", text: req.userText });

      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": version,
        },
        signal: req.signal,
        body: JSON.stringify({
          model: req.model,
          max_tokens: maxTokens,
          // Only send temperature when explicitly configured — several newer models 400 on it.
          ...(config.temperature != null ? { temperature: config.temperature } : {}),
          system: req.system,
          messages: [{ role: "user", content }],
          tools: [
            { name: req.toolName, description: "Report the verdict.", input_schema: req.toolSchema },
          ],
          tool_choice: { type: "tool", name: req.toolName },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new JudgeTransportError(res.status, `anthropic messages API ${res.status}: ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as {
        content?: { type: string; name?: string; input?: unknown }[];
      };
      const toolUse = json.content?.find((b) => b.type === "tool_use" && b.name === req.toolName);
      if (!toolUse) throw new Error("anthropic response contained no tool_use for the verdict");
      return toolUse.input;
    },
  };
}

export interface OpenAICompatibleTransportConfig {
  apiKey: string;
  /** Chat-completions API base (no trailing `/chat/completions`). Required — this is what selects
   *  the concrete backend (Gemini, a local Ollama server, OpenRouter, …). */
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * A transport for any OpenAI-**chat-completions**-compatible backend (Google Gemini's OpenAI
 * endpoint, a local Ollama/LM Studio server, OpenRouter, …). Sends the two images as `image_url`
 * data-URI blocks and forces a structured `{verdict, reasoning}` via `response_format: json_schema`.
 * One adapter, many backends — pick via `baseUrl` + model. Uses global `fetch` (no SDK).
 */
export function createOpenAICompatibleTransport(
  config: OpenAICompatibleTransportConfig,
): VisionJudgeTransport {
  const base = config.baseUrl.replace(/\/$/, "");
  const maxTokens = config.maxTokens ?? 1024;

  return {
    async invoke(req: VisionJudgeRequest): Promise<unknown> {
      const userContent: unknown[] = [];
      for (const img of req.images) {
        userContent.push({ type: "text", text: img.label });
        userContent.push({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${img.png.toString("base64")}` },
        });
      }
      userContent.push({ type: "text", text: req.userText });

      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        signal: req.signal,
        body: JSON.stringify({
          model: req.model,
          max_tokens: maxTokens,
          ...(config.temperature != null ? { temperature: config.temperature } : {}),
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: userContent },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: req.toolName, strict: true, schema: req.toolSchema },
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new JudgeTransportError(res.status, `chat-completions API ${res.status}: ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error("chat-completions response had no message content");
      // Some backends wrap JSON in ```json fences; strip them before parsing.
      const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      try {
        return JSON.parse(cleaned);
      } catch {
        throw new Error(`chat-completions content was not valid JSON: ${content.slice(0, 200)}`);
      }
    },
  };
}

export type JudgeProviderName = "anthropic" | "gemini" | "openai";

/** Google Gemini's OpenAI-compatible base. Gemini's free tier makes it the default free judge. */
export const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

export interface JudgeSettings {
  provider: JudgeProviderName;
  apiKey: string;
  model: string;
  /** Required for `openai` (a custom OpenAI-compatible endpoint); ignored for anthropic/gemini. */
  baseUrl?: string;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * The single factory that turns a resolved config into a {@link JudgeProvider}, picking the right
 * transport by provider. Shared by the env and DB-settings paths so provider selection lives in one
 * place. Returns undefined when the config is incomplete (missing key/model, or a custom `openai`
 * provider with no baseUrl) — a `context` checkpoint then fails its step loudly, never a false pass.
 */
export function buildJudge(cfg: Partial<JudgeSettings> | undefined): JudgeProvider | undefined {
  if (!cfg?.apiKey || !cfg.model) return undefined;
  const provider = (cfg.provider ?? "anthropic") as JudgeProviderName;

  let transport: VisionJudgeTransport;
  if (provider === "anthropic") {
    transport = createAnthropicTransport({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      temperature: cfg.temperature,
    });
  } else {
    const baseUrl = provider === "gemini" ? GEMINI_OPENAI_BASE : cfg.baseUrl;
    if (!baseUrl) return undefined; // a custom `openai` provider needs an explicit endpoint
    transport = createOpenAICompatibleTransport({
      apiKey: cfg.apiKey,
      baseUrl,
      temperature: cfg.temperature,
    });
  }

  return new VisionJudgeProvider({
    model: cfg.model,
    transport,
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
  });
}

/**
 * Build the judge from environment (used as a fallback when no DB settings exist — see the worker).
 * Reads: VARYS_JUDGE_PROVIDER (anthropic|gemini|openai, default anthropic), VARYS_JUDGE_MODEL,
 * VARYS_JUDGE_API_KEY, VARYS_JUDGE_BASE_URL?, VARYS_JUDGE_TEMPERATURE?, VARYS_JUDGE_TIMEOUT_MS?,
 * VARYS_JUDGE_MAX_RETRIES?. Returns undefined when unconfigured.
 */
export function createJudgeFromEnv(env: NodeJS.ProcessEnv = process.env): JudgeProvider | undefined {
  const num = (v: string | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return buildJudge({
    provider: (env.VARYS_JUDGE_PROVIDER ?? "anthropic").toLowerCase() as JudgeProviderName,
    apiKey: env.VARYS_JUDGE_API_KEY ?? "",
    model: env.VARYS_JUDGE_MODEL ?? "",
    baseUrl: env.VARYS_JUDGE_BASE_URL,
    temperature: num(env.VARYS_JUDGE_TEMPERATURE),
    timeoutMs: num(env.VARYS_JUDGE_TIMEOUT_MS),
    maxRetries: num(env.VARYS_JUDGE_MAX_RETRIES),
  });
}
