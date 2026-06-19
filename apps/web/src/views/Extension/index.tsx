import { Button, Card, CardHeader, Download, Globe, Lock, Puzzle } from "@varys/ui";
import type { ReactNode } from "react";
import { useToast } from "../../context/toast";
import styles from "./styles.module.scss";

/**
 * "Browser extension" page — the self-serve download + install guide for the Varys
 * recorder (Chrome MV3). The prebuilt, prod-pointed zip is produced by the web image
 * (deploy/Dockerfile.web) and served statically from the SPA origin at DOWNLOAD_URL,
 * so anyone signed in to the deployed app can grab it without a manual hand-off.
 *
 * The zip only exists in the deployed build; in local dev there's nothing at that path,
 * so the page also documents the from-source build command.
 */
const DOWNLOAD_URL = "/downloads/varys-extension-chrome.zip";
const BUILD_CMD =
  "WXT_API_BASE=https://varys.datagenie.ai pnpm --filter @varys/extension exec wxt zip";

const STEPS: { title: string; body: ReactNode }[] = [
  { title: "Download & unzip", body: "Download the zip above and unzip it anywhere." },
  {
    title: "Open the extensions page",
    body: (
      <>
        Paste <code>chrome://extensions</code> into Chrome's address bar (it can't be a
        clickable link).
      </>
    ),
  },
  { title: "Enable Developer mode", body: "Flip the Developer mode toggle, top-right." },
  {
    title: "Load unpacked",
    body: (
      <>
        Click <strong>Load unpacked</strong> and select the unzipped folder.
      </>
    ),
  },
  {
    title: "Sign in & record",
    body: (
      <>
        Make sure you're signed in here, then click the Varys icon — the panel marker
        should read <strong>Online</strong>.
      </>
    ),
  },
];

export function Extension() {
  const { toast } = useToast();
  const copy = (text: string, label: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast(`${label} copied`))
      .catch(() => toast("Couldn't copy"));
  };

  return (
    <div className={styles.page}>
      <Card className={styles.hero}>
        <span className={styles.heroIcon}>
          <Puzzle size={30} />
        </span>
        <div className={styles.heroBody}>
          <h2 className={styles.heroTitle}>Varys recorder for Chrome</h2>
          <p className={styles.heroLede}>
            Record visual-regression tests right as you click through your app, then save
            them straight to Varys. No separate login — it rides your Varys session.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.download} href={DOWNLOAD_URL} download>
              <Download size={18} />
              Download for Chrome
            </a>
            <span className={styles.req}>
              <Lock size={14} />
              Requires a datagenie.ai Google account signed in here
            </span>
          </div>
          {import.meta.env.DEV && (
            <p className={styles.devNote}>
              You're on a dev build — the prebuilt download only exists on the deployed
              app. Build it from source with the command below.
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Globe size={18} />} title="Install in Chrome" />
        <ol className={styles.steps}>
          {STEPS.map((step, i) => (
            <li key={step.title} className={styles.step}>
              <span className={styles.stepNum}>{i + 1}</span>
              <div className={styles.stepText}>
                <span className={styles.stepTitle}>{step.title}</span>
                <span className={styles.stepBody}>{step.body}</span>
              </div>
            </li>
          ))}
        </ol>
        <div className={styles.copyRow}>
          <code className={styles.code}>chrome://extensions</code>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => copy("chrome://extensions", "Address")}
          >
            Copy
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader icon={<Puzzle size={18} />} title="Build it yourself" />
        <p className={styles.bodyText}>
          For local development, or to point the extension at a different API, build it
          from source. The API URL is baked in at build time via <code>WXT_API_BASE</code>.
        </p>
        <div className={styles.copyRow}>
          <code className={styles.code}>{BUILD_CMD}</code>
          <Button size="sm" variant="secondary" onClick={() => copy(BUILD_CMD, "Command")}>
            Copy
          </Button>
        </div>
        <p className={styles.bodyMuted}>
          Output: <code>apps/extension/.output/chrome-mv3/</code> — load that folder
          unpacked (steps above).
        </p>
      </Card>
    </div>
  );
}
