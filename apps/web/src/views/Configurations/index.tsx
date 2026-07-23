import {
  DEFAULT_PER_PIXEL_THRESHOLD,
  DEFAULT_RATIO_THRESHOLD,
  type ImageComparisonSettings,
  JUDGE_PROVIDERS,
  type JudgeProviderName,
  type JudgeSettingsView,
} from "@varys/review-contract";
import { Badge, Button, ErrorState, Input, Select, Skeleton, Sliders } from "@varys/ui";
import { useEffect, useState } from "react";
import { useToast } from "../../context/toast";
import {
  useImageComparisonSettings,
  useJudgeSettings,
  useSaveImageComparisonSettings,
  useSaveJudgeSettings,
} from "../../queries";
import styles from "./styles.module.scss";

/** A sensible default model to suggest per provider (placeholder in the model field). */
const MODEL_PLACEHOLDER: Record<JudgeProviderName, string> = {
  gemini: "gemini-2.0-flash",
  anthropic: "claude-sonnet-5",
  openai: "e.g. llava, qwen2.5-vl, gpt-4o-mini",
};

/** Floats from a slider vs. a server round-trip — compare with a small tolerance. */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/** A plain word for where a slider sits, shown under the middle of the track. */
function pixelWord(v: number): string {
  if (v <= 0.05) return "Very strict";
  if (v <= 0.15) return "Balanced";
  if (v <= 0.4) return "Relaxed";
  return "Very relaxed";
}
function changeWord(v: number): string {
  if (v <= 0) return "Strictest";
  if (v <= 0.02) return "Strict";
  if (v <= 0.08) return "Balanced";
  if (v <= 0.15) return "Relaxed";
  return "Very relaxed";
}

/** The Configurations page. Today it holds one card — the global image-comparison defaults. */
export function Configurations() {
  const query = useImageComparisonSettings();

  if (query.isLoading) {
    return (
      <div className={styles.page}>
        <Skeleton height={520} radius="var(--radius-xl)" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className={styles.page}>
        <ErrorState
          title="Couldn’t load configuration"
          description="Fetching the image-comparison settings failed."
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <ImageComparisonCard settings={query.data} />
      <JudgeCard />
      <p className={styles.comingSoon}>
        More settings coming soon — capture, schedules and notifications.
      </p>
    </div>
  );
}

/** The context-compare judge config — provider + model + a masked API key. Drives what the worker
 *  uses to judge `context` checkpoints (Briefs / Wisdom); applies from the next run. */
function JudgeCard() {
  const query = useJudgeSettings();
  if (query.isLoading) return <Skeleton height={320} radius="var(--radius-xl)" />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title="Couldn’t load the AI judge settings"
        description="Fetching the judge configuration failed."
        onRetry={() => query.refetch()}
      />
    );
  }
  return <JudgeCardForm settings={query.data} />;
}

function JudgeCardForm({ settings }: { settings: JudgeSettingsView }) {
  const { toast } = useToast();
  const save = useSaveJudgeSettings();

  const [provider, setProvider] = useState<JudgeProviderName>(settings.provider);
  const [model, setModel] = useState(settings.model);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? "");
  const [defaultPrompt, setDefaultPrompt] = useState(settings.defaultPrompt);
  // The key is never returned; the field starts empty and only replaces the stored key if typed.
  const [apiKey, setApiKey] = useState("");
  useEffect(() => {
    setProvider(settings.provider);
    setModel(settings.model);
    setBaseUrl(settings.baseUrl ?? "");
    setDefaultPrompt(settings.defaultPrompt);
    setApiKey("");
  }, [settings.provider, settings.model, settings.baseUrl, settings.defaultPrompt]);

  const dirty =
    provider !== settings.provider ||
    model !== settings.model ||
    baseUrl !== (settings.baseUrl ?? "") ||
    defaultPrompt !== settings.defaultPrompt ||
    apiKey.trim().length > 0;

  const onSave = () => {
    const patch: Parameters<typeof save.mutate>[0] = { provider, model: model.trim(), defaultPrompt };
    if (provider === "openai") patch.baseUrl = baseUrl.trim();
    if (apiKey.trim().length > 0) patch.apiKey = apiKey.trim();
    save.mutate(patch, {
      onSuccess: () => toast("AI judge settings saved — applied from the next run"),
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t save judge settings"),
    });
  };

  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.headerIcon}>
          <Sliders size={19} />
        </span>
        <div className={styles.headerText}>
          <h2 className={styles.title}>AI judge (context comparison)</h2>
          <p className={styles.subtitle}>
            For checkpoints set to “AI context”, an LLM compares the current capture against the
            baseline instead of pixel-diffing. Choose a provider and paste its API key.
          </p>
        </div>
        <Button variant="primary" size="md" loading={save.isPending} disabled={!dirty} onClick={onSave}>
          Save changes
        </Button>
      </header>

      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>Provider</span>
          {provider === "gemini" && (
            <Badge tone="primary" size="sm">
              free tier
            </Badge>
          )}
        </div>
        <Select
          options={JUDGE_PROVIDERS}
          value={provider}
          onValueChange={(v) => setProvider(v as JudgeProviderName)}
        />
      </div>

      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>Model</span>
        </div>
        <Input
          value={model}
          placeholder={MODEL_PLACEHOLDER[provider]}
          aria-label="Judge model"
          onChange={(e) => setModel(e.target.value)}
        />
      </div>

      {provider === "openai" && (
        <div className={styles.setting}>
          <div className={styles.settingHead}>
            <span className={styles.settingTitle}>Endpoint (OpenAI-compatible base URL)</span>
          </div>
          <p className={styles.settingDesc}>
            e.g. a local Ollama server (<code>http://localhost:11434/v1</code>) or OpenRouter.
          </p>
          <Input
            value={baseUrl}
            placeholder="http://localhost:11434/v1"
            aria-label="OpenAI-compatible endpoint"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
      )}

      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>API key</span>
          {settings.apiKeySet && (
            <Badge tone="info" size="sm">
              set · ····{settings.apiKeyHint}
            </Badge>
          )}
        </div>
        <p className={styles.settingDesc}>
          {settings.apiKeySet
            ? "A key is stored. Leave blank to keep it, or paste a new one to replace it."
            : "Paste the provider’s API key. It’s stored server-side and never shown again."}
        </p>
        <Input
          type="password"
          value={apiKey}
          mono
          placeholder={settings.apiKeySet ? "•••••••• (unchanged)" : "paste API key"}
          aria-label="Judge API key"
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>Default judge prompt</span>
        </div>
        <p className={styles.settingDesc}>
          The instruction every “AI context” checkpoint uses by default — so you don’t re-type it per
          test. A checkpoint can still set its own prompt to override this.
        </p>
        <textarea
          className={styles.promptTextarea}
          rows={4}
          value={defaultPrompt}
          aria-label="Default judge prompt"
          placeholder="e.g. Both images are AI-generated pages. Ignore differences in wording, numbers, and chart values. Fail only if the current one is blank, an error/loading state, or structurally broken versus the baseline."
          onChange={(e) => setDefaultPrompt(e.target.value)}
        />
      </div>
    </section>
  );
}

function ImageComparisonCard({ settings }: { settings: ImageComparisonSettings }) {
  const { toast } = useToast();
  const save = useSaveImageComparisonSettings();

  // Local draft, seeded from the saved values and re-synced whenever they change
  // (initial load + after a successful save).
  const [perPixel, setPerPixel] = useState(settings.perPixel);
  const [ratio, setRatio] = useState(settings.ratio);
  useEffect(() => {
    setPerPixel(settings.perPixel);
    setRatio(settings.ratio);
  }, [settings.perPixel, settings.ratio]);

  const dirty = !near(perPixel, settings.perPixel) || !near(ratio, settings.ratio);

  const onSave = () => {
    save.mutate(
      { perPixel, ratio },
      {
        onSuccess: () => toast("Comparison settings saved — applied from the next run"),
        onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t save settings"),
      },
    );
  };

  return (
    <section className={styles.card}>
      {/* Header */}
      <header className={styles.header}>
        <span className={styles.headerIcon}>
          <Sliders size={19} />
        </span>
        <div className={styles.headerText}>
          <h2 className={styles.title}>Image comparison</h2>
          <p className={styles.subtitle}>
            How Varys decides whether a screenshot has changed. These apply to every test — a single
            test can still set its own values.
          </p>
        </div>
        <Button variant="primary" size="md" loading={save.isPending} disabled={!dirty} onClick={onSave}>
          Save changes
        </Button>
      </header>

      {/* Plain explanation of the two-step check */}
      <div className={styles.note}>
        Two checks run in order. First, Varys looks at each dot of colour (a <strong>pixel</strong>)
        and decides whether it changed. Then it counts how many changed, if too many did, the
        screenshot is flagged for a look.
      </div>

      {/* Pipeline strip */}
      <div className={styles.pipeline}>
        <div className={styles.stage}>
          <div className={styles.stageKicker}>1 · Check each pixel</div>
          <div className={styles.stageBody}>Decide which pixels look different enough to count as changed.</div>
        </div>
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
        <div className={styles.stage}>
          <div className={styles.stageKicker}>2 · Count them</div>
          <div className={styles.stageBody}>Add up the changed pixels as a share of the whole picture.</div>
        </div>
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
        <div className={styles.stage}>
          <div className={styles.stageKickerWarn}>3 · Decide</div>
          <div className={styles.stageBody}>If more changed than you allow, the screenshot is flagged.</div>
        </div>
      </div>

      {/* Setting 1 — per-pixel sensitivity */}
      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>How different a pixel must be</span>
        </div>
        <p className={styles.settingDesc}>
          A pixel’s colour can shift a little for harmless reasons, like text being smoothed. Move
          left to notice even tiny changes, move right to ignore small ones.
        </p>
        <div className={styles.sliderRow}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={perPixel}
            aria-label="How different a pixel must be"
            onChange={(e) => setPerPixel(Number(e.target.value))}
            className={styles.slider}
          />
          <span className={styles.value}>{perPixel.toFixed(2)}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={near(perPixel, DEFAULT_PER_PIXEL_THRESHOLD)}
            onClick={() => setPerPixel(DEFAULT_PER_PIXEL_THRESHOLD)}
          >
            Reset
          </Button>
        </div>
        <div className={styles.scale}>
          <span>Notice everything</span>
          <span className={styles.scaleMid}>{pixelWord(perPixel)}</span>
          <span>Ignore colour</span>
        </div>
      </div>

      {/* Setting 2 — allowed change ("the threshold") */}
      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>How much of the screenshot can change</span>
          <Badge tone="primary" size="sm">
            this is “the threshold”
          </Badge>
        </div>
        <p className={styles.settingDesc}>
          The share of the screenshot allowed to change before it’s flagged for review. If more than
          this changes, the screenshot needs a look.
        </p>
        <div className={styles.sliderRow}>
          <input
            type="range"
            min={0}
            max={0.25}
            step={0.001}
            value={ratio}
            aria-label="How much of the screenshot can change"
            onChange={(e) => setRatio(Number(e.target.value))}
            className={styles.slider}
          />
          <span className={styles.value}>{(ratio * 100).toFixed(1)}%</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={near(ratio, DEFAULT_RATIO_THRESHOLD)}
            onClick={() => setRatio(DEFAULT_RATIO_THRESHOLD)}
          >
            Reset
          </Button>
        </div>
        <div className={styles.scale}>
          <span>0% · flag any change</span>
          <span className={styles.scaleMid}>{changeWord(ratio)}</span>
          <span>25% · very relaxed</span>
        </div>
      </div>
    </section>
  );
}
