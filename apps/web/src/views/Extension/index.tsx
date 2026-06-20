import { Card, CardHeader, Check, cx, Download, Globe, Lock, Puzzle } from "@varys/ui";
import { type ReactNode, useState } from "react";
import { useToast } from "../../context/toast";
import styles from "./styles.module.scss";

/**
 * "Browser extension" page — the self-serve download + install guide for the Varys recorder
 * (Chrome MV3). The prebuilt, prod-pointed zip is produced by the web image (deploy/Dockerfile.web)
 * and served statically from the SPA origin at DOWNLOAD_URL, so anyone signed in to the deployed
 * app can grab it without a manual hand-off.
 *
 * The zip only exists in the deployed build; in local dev there's nothing at that path, so the
 * page also documents the from-source build command. Styled to match the Author-with-AI screen.
 */
const DOWNLOAD_URL = "/downloads/varys-extension-chrome.zip";
const BUILD_CMD =
  "WXT_API_BASE=https://varys.datagenie.ai pnpm --filter @varys/extension exec wxt zip";

/** A small clipboard glyph (local — not in the shared icon set). */
function CopyGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function Extension() {
  const { toast } = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, key: string, label: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
        toast(`${label} copied`);
      })
      .catch(() => toast("Couldn’t copy"));
  };

  const steps: { title: string; body: ReactNode }[] = [
    { title: "Download & unzip", body: "Download the zip above and unzip it anywhere." },
    {
      title: "Open the extensions page",
      body: (
        <>
          Paste{" "}
          <button
            type="button"
            className={styles.codeChip}
            onClick={() => copy("chrome://extensions", "addr", "Address")}
          >
            chrome://extensions
            {copied === "addr" ? <Check size={12} /> : <CopyGlyph />}
          </button>{" "}
          into Chrome’s address bar — it can’t be a clickable link.
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
          Make sure you’re signed in here, then click the Varys icon — the panel marker should read{" "}
          <strong>Online</strong>.
        </>
      ),
    },
  ];

  return (
    <div className={styles.page}>
      {/* hero */}
      <div className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden />
        <div className={styles.heroInner}>
          <span className={styles.heroIcon}>
            <Puzzle size={28} />
          </span>
          <span className={styles.heroPill}>
            <span className={styles.heroPillDot} />
            Chrome · MV3
          </span>
          <h2 className={styles.heroTitle}>Varys recorder for Chrome</h2>
          <p className={styles.heroDesc}>
            Record visual-regression tests right as you click through your app, then save them
            straight to Varys. No separate login — it rides your Varys session.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.download} href={DOWNLOAD_URL} download>
              <Download size={18} />
              Download for Chrome
            </a>
            <span className={styles.req}>
              <Lock size={13} />
              Requires a datagenie.ai Google account signed in here
            </span>
          </div>
          {import.meta.env.DEV && (
            <p className={styles.devNote}>
              You’re on a dev build — the prebuilt download only exists on the deployed app. Build it
              from source below.
            </p>
          )}
        </div>
      </div>

      {/* install */}
      <Card>
        <CardHeader icon={<Globe size={18} />} title="Install in Chrome" />
        <ol className={styles.steps}>
          {steps.map((s, i) => (
            <li key={s.title} className={styles.step}>
              <span className={styles.stepNum}>{i + 1}</span>
              <div className={styles.stepText}>
                <span className={styles.stepTitle}>{s.title}</span>
                <span className={styles.stepBody}>{s.body}</span>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      {/* build from source */}
      <Card>
        <CardHeader icon={<Puzzle size={18} />} title="Build from source" />
        <p className={styles.bodyText}>
          For local development, or to point the extension at a different API, build it yourself —
          the API URL is baked in at build time via <code>WXT_API_BASE</code>.
        </p>
        <div className={styles.term}>
          <div className={styles.termBar}>
            <span className={cx(styles.termLight, styles.termRed)} />
            <span className={cx(styles.termLight, styles.termAmber)} />
            <span className={cx(styles.termLight, styles.termGreen)} />
            <span className={styles.termLabel}>terminal</span>
          </div>
          <div className={styles.termBody}>
            <span className={styles.termCmd}>
              <span className={styles.termPrompt}>$</span> {BUILD_CMD}
            </span>
            <button
              type="button"
              className={styles.termCopy}
              onClick={() => copy(BUILD_CMD, "cmd", "Command")}
              aria-label="Copy command"
            >
              {copied === "cmd" ? <Check size={14} /> : <CopyGlyph />}
              {copied === "cmd" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <p className={styles.bodyMuted}>
          Output: <code>apps/extension/.output/chrome-mv3/</code> — load that folder unpacked (steps
          above).
        </p>
      </Card>
    </div>
  );
}
