import type { BridgeChatState } from "@varys/review-contract";
import { AlertTriangle, Button, Check, Puzzle, Spinner } from "@varys/ui";
import { useEffect, useState } from "react";
import { API_ORIGIN } from "../../api";
import { useCreateBridge } from "../../queries";
import styles from "./styles.module.scss";

/**
 * Pair a **Bridge Helper** — the step that stands between "no helper is paired" and a working Run
 * button, offered where the user hits the wall rather than on a page they have to be told to find.
 *
 * Pairing is a one-time code read out to a process on the user's own machine. That shape is the
 * whole security story in miniature: Varys never reaches onto the laptop, the laptop reaches in,
 * and the code it presents is single-use and short-lived, so a code seen over someone's shoulder
 * an hour later is worth nothing.
 *
 * This component shows the code and the command; it does not poll for the outcome. The parent is
 * already asking the server whether a helper is listening, and that answer — not this component's
 * opinion — is what makes the Run button live. Two sources of truth for "are we paired?" is how a
 * button and its notice end up disagreeing on screen.
 */
export function BridgeHelperPairing() {
  const start = useCreateBridge();
  const [chat, setChat] = useState<BridgeChatState | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const expiresAt = chat?.pairingExpiresAt ?? null;
  const secondsLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : null;
  const expired = secondsLeft === 0;

  // Tick only while a live code is on screen. The countdown is not decoration: the code really
  // does stop working, and a user typing it into a terminal deserves to know how long they have
  // rather than discovering it from a refusal.
  useEffect(() => {
    if (!expiresAt || Date.now() >= expiresAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  const command = commandFor(chat?.pairingCode ?? "<code>");

  function copy() {
    navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => undefined,
    );
  }

  if (!chat || expired) {
    return (
      <div className={styles.start}>
        {expired && (
          <span className={styles.expired}>
            <AlertTriangle size={14} />
            That code expired before a helper used it.
          </span>
        )}
        <Button
          variant="secondary"
          size="sm"
          iconLeft={start.isPending ? <Spinner size={14} /> : <Puzzle size={14} />}
          disabled={start.isPending}
          onClick={() =>
            start.mutate(undefined, {
              onSuccess: (created) => {
                setChat(created);
                setNow(Date.now());
              },
            })
          }
        >
          {expired ? "Get a new code" : "Pair a helper"}
        </Button>
        {start.isError && (
          <span className={styles.expired}>
            <AlertTriangle size={14} />
            {start.error instanceof Error ? start.error.message : "Couldn’t start a pairing"}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={styles.pairing}>
      <div className={styles.lead}>
        Run this on the machine you want the test to run on. It launches <strong>your</strong>{" "}
        Claude, under your own subscription — Varys never sees a key and drives no browser.
      </div>
      <div className={styles.cmdRow}>
        <code className={styles.cmd}>{command}</code>
        <Button variant="ghost" size="sm" iconLeft={copied ? <Check size={14} /> : undefined} onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {/* Things the command alone cannot say, and both have bitten. `pnpm connect` only resolves
          inside the checkout — and the directory it is launched from is ALSO where Claude will
          run, so the obvious `cd` into the repo quietly points the agent at the wrong project. */}
      <div className={styles.note}>
        {LOCAL_DEV && <>Run it from your Varys checkout. </>}
        Claude starts in whatever directory you launch it from — set{" "}
        <code>VARYS_CONNECT_CWD</code> to run it somewhere else.
      </div>
      <div className={styles.foot}>
        {secondsLeft !== null && (
          <span className={styles.countdown}>
            Code expires in {secondsLeft}s — it is good for one helper, once.
          </span>
        )}
        <span className={styles.waiting}>
          <Spinner size={13} /> Waiting for it to connect…
        </span>
      </div>
    </div>
  );
}

/** True when this page is talking to a local dev API — the only case where the reader is
 *  guaranteed to have a checkout to run the helper from. */
const LOCAL_DEV = API_ORIGIN === "http://localhost:4000";

/**
 * The command, which is a different command depending on how this Varys is reached.
 *
 * On a local checkout the helper is right there in the workspace, and `pnpm connect` is the
 * shortest true thing to say. On a deployed Varys the reader has no checkout at all, so the
 * command installs the helper straight from the origin serving this page — which also means it
 * can never be a version older than the Varys it was downloaded from.
 *
 * `VARYS_API` is spelled out in the deployed case because the helper talks to the API directly,
 * with no proxy in front of it, and defaults to localhost. It is the one value a reader cannot
 * guess, so it leads.
 */
function commandFor(code: string): string {
  if (LOCAL_DEV) return `pnpm connect ${code}`;
  return `VARYS_API=${API_ORIGIN} npx ${API_ORIGIN}/downloads/varys-connect.tgz ${code}`;
}
