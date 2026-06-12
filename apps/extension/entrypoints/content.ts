import { captureFingerprint } from "@varys/capture";
import { type RecordedSession, startRecorder } from "@varys/recorder";

/**
 * Content script: wraps @varys/recorder. The popup drives it via messages —
 * start a session, enter inspect-mode to designate a checkpoint, then save
 * (returns the step definition for the popup to POST to the API).
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    let session: RecordedSession | null = null;
    let checkpointCount = 0;
    let highlighted: HTMLElement | null = null;

    const clearHighlight = () => {
      if (highlighted) highlighted.style.outline = highlighted.dataset.varysOutline ?? "";
      highlighted = null;
    };

    const onHover = (e: MouseEvent) => {
      clearHighlight();
      const el = e.target as HTMLElement;
      el.dataset.varysOutline = el.style.outline;
      el.style.outline = "2px solid #3366cc";
      highlighted = el;
    };

    const onPick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target as Element;
      session?.checkpoint(el, `checkpoint-${++checkpointCount}`);
      stopPicking();
    };

    const stopPicking = () => {
      document.removeEventListener("mousemove", onHover, true);
      document.removeEventListener("click", onPick, true);
      clearHighlight();
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    browser.runtime.onMessage.addListener((msg: any) => {
      if (msg?.type === "varys:start") {
        session = startRecorder(captureFingerprint);
        return Promise.resolve({ ok: true });
      }
      if (msg?.type === "varys:pick") {
        document.addEventListener("mousemove", onHover, true);
        document.addEventListener("click", onPick, true);
        return Promise.resolve({ ok: true });
      }
      if (msg?.type === "varys:save") {
        const definition = session?.getDefinition(msg.name ?? "recorded", {
          width: window.innerWidth,
          height: window.innerHeight,
          deviceScaleFactor: window.devicePixelRatio,
        });
        return Promise.resolve({ definition: definition ?? null });
      }
      return undefined;
    });
  },
});
