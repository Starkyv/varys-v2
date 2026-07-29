import {
  DEFAULT_PER_PIXEL_THRESHOLD,
  DEFAULT_RATIO_THRESHOLD,
  type ImageComparisonSettings,
  JUDGE_PROVIDERS,
  type JudgeProviderName,
  type JudgeSettingsView,
  type SlackSettingsView,
} from "@varys/review-contract";
import { Badge, Button, ErrorState, Input, Select, Skeleton, Sliders, Switch } from "@varys/ui";
import { useEffect, useState } from "react";
import { useToast } from "../../context/toast";
import {
  useImageComparisonSettings,
  useJudgeSettings,
  useSaveImageComparisonSettings,
  useSaveJudgeSettings,
  useSaveSlackSettings,
  useSendSlackTest,
  useSlackSettings,
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
      <SlackCard />
      <p className={styles.comingSoon}>More settings coming soon — capture and schedules.</p>
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

/** Slack run-completion notifications — a bot token + channel. When configured (with at least one
 *  source on), the worker posts a message after every run: a single test (manual/scheduled) and,
 *  via fan-in, once per suite run. */
function SlackCard() {
  const query = useSlackSettings();
  if (query.isLoading) return <Skeleton height={320} radius="var(--radius-xl)" />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title="Couldn’t load the Slack settings"
        description="Fetching the Slack configuration failed."
        onRetry={() => query.refetch()}
      />
    );
  }
  return <SlackCardForm settings={query.data} />;
}

/** One label+description row with a trailing switch, for the Slack "Notify on" group. */
function ToggleRow({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleRowText}>
        <div className={styles.toggleRowTitle}>{title}</div>
        <div className={styles.toggleRowHint}>{hint}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={`Notify on ${title.toLowerCase()}`} />
    </div>
  );
}

function SlackCardForm({ settings }: { settings: SlackSettingsView }) {
  const { toast } = useToast();
  const save = useSaveSlackSettings();
  const test = useSendSlackTest();

  const [notifyManual, setNotifyManual] = useState(settings.notifyManual);
  const [notifySchedule, setNotifySchedule] = useState(settings.notifySchedule);
  const [notifySuite, setNotifySuite] = useState(settings.notifySuite);
  const [attachPdf, setAttachPdf] = useState(settings.attachPdf);
  const [channel, setChannel] = useState(settings.channel);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? "");
  // The token is never returned; the field starts empty and only replaces the stored one if typed.
  const [token, setToken] = useState("");
  useEffect(() => {
    setNotifyManual(settings.notifyManual);
    setNotifySchedule(settings.notifySchedule);
    setNotifySuite(settings.notifySuite);
    setAttachPdf(settings.attachPdf);
    setChannel(settings.channel);
    setBaseUrl(settings.baseUrl ?? "");
    setToken("");
  }, [
    settings.notifyManual,
    settings.notifySchedule,
    settings.notifySuite,
    settings.attachPdf,
    settings.channel,
    settings.baseUrl,
  ]);

  const dirty =
    notifyManual !== settings.notifyManual ||
    notifySchedule !== settings.notifySchedule ||
    notifySuite !== settings.notifySuite ||
    attachPdf !== settings.attachPdf ||
    channel !== settings.channel ||
    baseUrl !== (settings.baseUrl ?? "") ||
    token.trim().length > 0;

  const buildPatch = () => {
    const patch: Parameters<typeof save.mutate>[0] = {
      notifyManual,
      notifySchedule,
      notifySuite,
      attachPdf,
      channel: channel.trim(),
      baseUrl: baseUrl.trim(),
    };
    if (token.trim().length > 0) patch.token = token.trim();
    return patch;
  };

  const allMuted = !notifyManual && !notifySchedule && !notifySuite;

  const onSave = () => {
    save.mutate(buildPatch(), {
      onSuccess: () => toast("Slack settings saved — applied from the next run"),
      onError: (e) => toast(e instanceof Error ? e.message : "Couldn’t save Slack settings"),
    });
  };

  // Save the current form first (so the test uses exactly what's on screen), then post the test.
  const onTest = async () => {
    try {
      if (dirty) await save.mutateAsync(buildPatch());
      await test.mutateAsync();
      toast("Test message sent — check your Slack channel");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Slack test failed");
    }
  };

  const canTest = settings.tokenSet || token.trim().length > 0;

  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.headerIcon}>
          <Sliders size={19} />
        </span>
        <div className={styles.headerText}>
          <h2 className={styles.title}>Slack notifications</h2>
          <p className={styles.subtitle}>
            Post a message to Slack when a run finishes — a single test (manual or scheduled) and,
            once per suite run. Needs a Slack app bot token with <code>chat:write</code>.
          </p>
        </div>
        <Button variant="primary" size="md" loading={save.isPending} disabled={!dirty} onClick={onSave}>
          Save changes
        </Button>
      </header>

      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>Notify on</span>
          {allMuted && (
            <Badge tone="neutral" size="sm">
              all off — no notifications
            </Badge>
          )}
        </div>
        <p className={styles.settingDesc}>
          Which runs post a message — each is independent. There’s no separate on/off: turning every
          source off disables Slack entirely.
        </p>
        <div className={styles.toggleGroup}>
          <ToggleRow
            title="Manual runs"
            hint="On-demand — the Run button or API"
            checked={notifyManual}
            onChange={setNotifyManual}
          />
          <ToggleRow
            title="Scheduled runs"
            hint="Cron test schedules"
            checked={notifySchedule}
            onChange={setNotifySchedule}
          />
          <ToggleRow
            title="Suite runs"
            hint="One summary per suite run (manual or cron)"
            checked={notifySuite}
            onChange={setNotifySuite}
          />
        </div>
      </div>

      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>Attach PDF report</span>
          <Switch checked={attachPdf} onCheckedChange={setAttachPdf} aria-label="Attach PDF report" />
        </div>
        <p className={styles.settingDesc}>
          Render a flow-report PDF (status, counts, per-checkpoint/test breakdown) and attach it to
          each message.
        </p>
      </div>

      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>Bot token</span>
          {settings.tokenSet && (
            <Badge tone="info" size="sm">
              set · ····{settings.tokenHint}
            </Badge>
          )}
        </div>
        <p className={styles.settingDesc}>
          {settings.tokenSet
            ? "A token is stored. Leave blank to keep it, or paste a new one to replace it."
            : "Paste your Slack app’s bot token (starts with xoxb-). Stored server-side, never shown again."}
        </p>
        <Input
          type="password"
          value={token}
          mono
          placeholder={settings.tokenSet ? "•••••••• (unchanged)" : "xoxb-…"}
          aria-label="Slack bot token"
          onChange={(e) => setToken(e.target.value)}
        />
      </div>

      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>Channel</span>
        </div>
        <p className={styles.settingDesc}>
          The channel id (e.g. <code>C0123ABCD</code>) or <code>#name</code>. Invite the bot to it first.
        </p>
        <Input
          value={channel}
          mono
          placeholder="#qa-varys or C0123ABCD"
          aria-label="Slack channel"
          onChange={(e) => setChannel(e.target.value)}
        />
      </div>

      <div className={styles.setting}>
        <div className={styles.settingHead}>
          <span className={styles.settingTitle}>Varys base URL</span>
        </div>
        <p className={styles.settingDesc}>
          Where this app is reached (e.g. <code>https://varys.internal</code>) — used for the “View run”
          link in each message. Leave blank to omit the link.
        </p>
        <Input
          value={baseUrl}
          mono
          placeholder="https://varys.internal"
          aria-label="Varys base URL"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      <div className={styles.setting}>
        <Button variant="secondary" size="sm" loading={test.isPending || save.isPending} disabled={!canTest} onClick={() => void onTest()}>
          Send test message
        </Button>
      </div>
    </section>
  );
}
