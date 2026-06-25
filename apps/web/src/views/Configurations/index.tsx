import {
  DEFAULT_PER_PIXEL_THRESHOLD,
  DEFAULT_RATIO_THRESHOLD,
  type ImageComparisonSettings,
} from "@varys/review-contract";
import { Badge, Button, ErrorState, Skeleton, Sliders } from "@varys/ui";
import { useEffect, useState } from "react";
import { useToast } from "../../context/toast";
import { useImageComparisonSettings, useSaveImageComparisonSettings } from "../../queries";
import styles from "./styles.module.scss";

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
      <p className={styles.comingSoon}>
        More settings coming soon — capture, schedules and notifications.
      </p>
    </div>
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
