import { createServer } from "node:http";

/**
 * Deterministic in-repo target app. It stands in for "the app under test" so
 * record/replay/diff tests never depend on a real external site or the network.
 * Static, no animations, fixed content — so screenshots are byte-stable.
 *
 * `setVariant` lets a test change what the same URL renders, so one test can
 * seed a baseline and then produce a visual diff on a later run.
 */
export type Variant =
  | "default"
  | "changed"
  | "login"
  | "deferred"
  | "stampA"
  | "stampB"
  | "hovermenu"
  | "checkbox"
  | "busy"
  | "streaming"
  | "editor"
  | "iframe"
  | "twins"
  | "locatorRepair"
  | "locatorRepairBroken"
  | "locatorRepairDeleted";

function html(variant: Variant): string {
  // A stable hero with one volatile sub-region (#stamp, top-left) — stampA/stampB
  // differ ONLY in the stamp's colour, so a mask over that region removes the diff
  // while the rest of the element stays identical.
  if (variant === "stampA" || variant === "stampB") {
    const stamp = variant === "stampA" ? "#22aa22" : "#ee8800";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Stamp</title>
<style>
  * { margin: 0; }
  body { background: #ffffff; font-family: Arial, sans-serif; }
  #hero {
    position: relative;
    width: 240px; height: 120px; margin: 24px;
    background: #3366cc; color: #ffffff;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }
  #stamp { position: absolute; top: 0; left: 0; width: 80px; height: 30px; background: ${stamp}; }
</style>
</head>
<body>
  <div id="hero"><span id="stamp"></span>Hero</div>
</body>
</html>`;
  }

  if (variant === "login") {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Login</title>
<style>
  * { margin: 0; }
  body { background: #ffffff; font-family: Arial, sans-serif; padding: 24px; }
  input, button { display: block; margin: 8px 0; font-size: 16px; }
  #app {
    width: 240px; height: 80px; margin-top: 16px;
    background: #2e7d32; color: #ffffff;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }
</style>
</head>
<body>
  <form onsubmit="return false">
    <input id="username" placeholder="username" />
    <input id="password" type="password" placeholder="password" />
    <button id="submit" type="button" onclick="document.getElementById('app').textContent = 'Welcome'">Log in</button>
  </form>
  <div id="app"></div>
</body>
</html>`;
  }

  if (variant === "editor") {
    // A rich-text / markdown editor is a `contenteditable` div (not input/textarea), like the
    // Domain Knowledge / Skills editors. The Save button stays disabled until the editor has
    // content — so a recording that fails to capture the typed content can't enable Save. This
    // proves the recorder captures contenteditable typing and replay fills it.
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Editor</title>
<style>
  * { margin: 0; }
  body { background: #ffffff; font-family: Arial, sans-serif; padding: 24px; }
  #editor { min-height: 80px; width: 400px; border: 1px solid #ccc; padding: 8px; font-size: 16px; }
  #save[disabled] { opacity: 0.5; }
  #out { margin-top: 12px; }
</style>
</head>
<body>
  <div id="editor" contenteditable="true" data-testid="dk-editor" role="textbox" aria-label="Knowledge"></div>
  <button id="save" type="button" data-testid="dk-save" disabled>Save</button>
  <div id="out"></div>
  <script>
    var ed = document.getElementById("editor");
    var save = document.getElementById("save");
    ed.addEventListener("input", function () { save.disabled = ed.innerText.trim().length === 0; });
    save.addEventListener("click", function () { document.getElementById("out").textContent = "saved: " + ed.innerText; });
  </script>
</body>
</html>`;
  }

  if (variant === "busy") {
    // Never reaches network idle: a periodic fetch keeps the network perpetually active (like a
    // streaming/polling SPA). Used to prove a `networkIdle` wait is best-effort — it settles up to
    // its timeout, then the step proceeds to the (immediately present) button instead of failing.
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Busy</title>
<style>* { margin: 0; } body { background:#fff; font-family: Arial, sans-serif; padding: 24px; }</style>
</head>
<body>
  <button id="go" type="button" data-testid="go">Go</button>
  <div id="out"></div>
  <script>
    document.getElementById("go").addEventListener("click", function () {
      document.getElementById("out").textContent = "clicked";
    });
    // Keep the network busy forever so 'networkidle' is never reached.
    setInterval(function () { fetch("/ping?t=" + Date.now()).catch(function () {}); }, 200);
  </script>
</body>
</html>`;
  }

  if (variant === "streaming") {
    // A streamed answer, the shape `streamIdle` exists for: a skeleton appears first, then text
    // arrives in chunks, then the skeleton is removed. Nothing here is gate-able by a selector
    // wait on the final content (its text keeps changing as it streams) and the page never
    // reaches network idle behaviour worth waiting on — only "the loading marker came and went,
    // and the DOM has gone quiet" identifies the end.
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Streaming</title>
<style>
  * { margin: 0; }
  body { background:#fff; font-family: Arial, sans-serif; padding: 24px; }
  #skeleton { width: 240px; height: 16px; background: #ddd; }
  #answer { width: 400px; font-size: 16px; }
</style>
</head>
<body>
  <div id="skeleton" data-testid="skeleton" aria-busy="true"></div>
  <div id="answer" data-testid="answer"></div>
  <script>
    var words = ["Revenue", "grew", "12%", "quarter", "over", "quarter."];
    var answer = document.getElementById("answer");
    var i = 0;
    // Chunks land every 120ms; when the last one has, the skeleton clears and the
    // post-completion action appears — the common "you can act on it now it's finished"
    // pattern, and the observable proof that a wait really settled rather than firing early.
    var t = setInterval(function () {
      if (i >= words.length) {
        clearInterval(t);
        var sk = document.getElementById("skeleton");
        if (sk) sk.parentNode.removeChild(sk);
        var copy = document.createElement("button");
        copy.id = "copy";
        copy.type = "button";
        copy.setAttribute("data-testid", "copy-answer");
        copy.textContent = "Copy answer";
        document.body.appendChild(copy);
        return;
      }
      answer.textContent += (i ? " " : "") + words[i++];
    }, 120);
  </script>
</body>
</html>`;
  }

  if (variant === "checkbox") {
    // A <label>-wrapped checkbox (the common pattern) + a text input. Clicking the label fires
    // the label click AND a synthetic click on the control, plus one `change` — exercising that
    // the recorder emits exactly ONE click step for the toggle (never an un-fillable type step).
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Checkbox</title>
<style>
  * { margin: 0; }
  body { background: #ffffff; font-family: Arial, sans-serif; padding: 24px; }
  label { display: flex; gap: 8px; align-items: center; margin: 8px 0; font-size: 16px; }
  #out { margin-top: 16px; }
</style>
</head>
<body>
  <label id="internal-label" data-testid="chk-internal-label">
    <input type="checkbox" id="internal" data-testid="chk-internal" />
    <span>Exclude internal</span>
  </label>
  <input type="text" id="also" data-testid="also-input" placeholder="also exclude" />
  <div id="out"></div>
  <script>
    document.getElementById("internal").addEventListener("change", function () {
      document.getElementById("out").textContent = this.checked ? "excluded" : "included";
    });
  </script>
</body>
</html>`;
  }

  if (variant === "hovermenu") {
    // A JS-driven flyout: hovering #more reveals an absolutely-positioned menu (a sibling, not a
    // child of the trigger) containing a link the user clicks. Mirrors the real "hover a trigger →
    // menu appears → click an item" pattern. The menu is only created on hover, so a replay that
    // clicks the item WITHOUT first hovering #more can't find it — exactly what a recorded `hover`
    // step fixes. Left open once revealed (no mouseleave teardown) so the flow is deterministic.
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Hover menu</title>
<style>
  * { margin: 0; }
  body { background: #ffffff; font-family: Arial, sans-serif; padding: 24px; }
  #more { width: 64px; height: 32px; background: #334; color: #fff;
    display: flex; align-items: center; justify-content: center; }
  #flyout { position: absolute; left: 96px; top: 24px; background: #fff;
    border: 1px solid #ccc; padding: 8px; }
  #flyout button { display: block; font-size: 16px; }
  #out { margin-top: 96px; }
</style>
</head>
<body>
  <button id="more" type="button" data-testid="more-trigger" aria-label="More">More</button>
  <div id="out"></div>
  <script>
    var more = document.getElementById("more");
    more.addEventListener("mouseenter", function () {
      if (document.getElementById("flyout")) return;
      var fly = document.createElement("div");
      fly.id = "flyout";
      fly.setAttribute("role", "menu");
      var item = document.createElement("button");
      item.id = "explorer";
      item.type = "button";
      item.setAttribute("data-testid", "fly-explorer");
      item.textContent = "Explorer";
      item.addEventListener("click", function () {
        document.getElementById("out").textContent = "Explorer opened";
      });
      fly.appendChild(item);
      document.body.appendChild(fly);
    });
  </script>
</body>
</html>`;
  }

  if (variant === "deferred") {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Deferred</title>
<style>
  * { margin: 0; }
  body { background: #ffffff; font-family: Arial, sans-serif; }
  #hero {
    width: 240px; height: 120px; margin: 24px;
    background: #3366cc; color: #ffffff;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }
</style>
</head>
<body>
  <script>
    setTimeout(function () {
      var d = document.createElement("div");
      d.id = "hero";
      d.textContent = "Hero";
      document.body.appendChild(d);
    }, 2000);
  </script>
</body>
</html>`;
  }

  if (variant === "iframe") {
    // Content rendered INSIDE a same-origin `srcDoc` iframe — the DataGenie Brief report / Wisdom
    // visualization shape. The real content (`#report`, `data-testid="brief-body"`) lives in the
    // frame's document; a checkpoint must descend via `frameChain` to see or capture it.
    const inner =
      `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
      `<style>*{margin:0}body{font-family:Arial,sans-serif}` +
      `#report{width:300px;height:150px;background:#3366cc;color:#fff;` +
      `display:flex;align-items:center;justify-content:center;font-size:20px}</style></head>` +
      `<body><div id="report" data-testid="brief-body">Weekly Violations Summary</div></body></html>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Iframe</title>
<style>* { margin: 0; } body { background: #ffffff; font-family: Arial, sans-serif; padding: 24px; }
  #report-frame { width: 340px; height: 190px; border: 0; }</style>
</head>
<body>
  <iframe id="report-frame" data-testid="report-frame" srcdoc='${inner}'></iframe>
</body>
</html>`;
  }

  // Two rows of IDENTICAL controls, plus an unlabelled icon button — the shapes an
  // AI-authored test dies on. Nothing here carries a data-testid or a stable id, so the replay
  // matcher can only separate the twins by the row text around them, and cannot separate the
  // icon buttons at all. Used to prove the authoring snapshot FLAGS them (`duplicate`) and that
  // the locator probe refuses to bless them.
  if (variant === "twins") {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Twins</title>
<style>
  * { margin: 0; }
  body { background: #ffffff; font-family: Arial, sans-serif; padding: 24px; }
  li { list-style: none; margin: 12px 0; display: flex; gap: 12px; align-items: center; }
  button { font-size: 14px; }
  .icon { width: 24px; height: 24px; background: #888888; border: 0; }
  .tile { width: 160px; height: 90px; background: #dddddd; margin: 12px 0; cursor: pointer; }
  .card { width: 200px; height: 60px; background: #eeeeee; margin: 12px 0; cursor: pointer; }
</style>
</head>
<body>
  <ul>
    <li><span>Acme Corporation</span><button type="button">Edit</button><button type="button" class="icon"></button></li>
    <li><span>Globex Industries</span><button type="button">Edit</button><button type="button" class="icon"></button></li>
  </ul>
  <div class="tile" onclick="void 0"></div>
  <div class="tile" onclick="void 0"></div>
  <div><div class="card" onclick="void 0"></div></div>
  <div><div class="card" onclick="void 0"></div></div>
  <button id="new-report" type="button">New report</button>
</body>
</html>`;
  }

  // A REAL locator break, for the repair queue (Slice 19). The pair renders the same page with
  // one control renamed AND resized AND re-parented, so a fingerprint recorded against
  // `locatorRepair` genuinely has no signal left to match in `locatorRepairBroken`: the test id
  // and element id are different, the accessible name is different, the containing section's id
  // is different, and the box is far enough off that size similarity can't clear the matcher's
  // identifying-signal floor either. That is what makes the queue test a real hard-fail rather
  // than a stubbed one — exactly the "element moved/renamed" drift auto-repair exists for.
  //
  // `locatorRepairDeleted` is the third case, and the one the justification gate exists for
  // (Slice 19, slice 05): the control is not renamed, it is GONE — and a plausible DIFFERENT
  // control sits where it used to be. A repair agent can re-pin to that and produce a locator
  // that genuinely resolves, which is precisely why "it resolves" cannot be the only gate.
  if (
    variant === "locatorRepair" ||
    variant === "locatorRepairBroken" ||
    variant === "locatorRepairDeleted"
  ) {
    const broken = variant === "locatorRepairBroken";
    const deleted = variant === "locatorRepairDeleted";
    const key = deleted ? "refresh-btn" : broken ? "commit-btn" : "save-btn";
    const name = deleted ? "Refresh" : broken ? "Commit changes" : "Save changes";
    const label = deleted ? "Refresh" : broken ? "Commit" : "Save";
    // The deleted variant re-parents and resizes for the same reason the broken one does: the
    // recorded fingerprint must have NO signal left to match, or the matcher resolves it fuzzily
    // and the run never fails. Which is also the point of this pair — from the matcher's side the
    // two breaks are indistinguishable; only the justification gate can tell them apart.
    const panel = broken ? "editor-panel" : deleted ? "toolbar-panel" : "form-panel";
    const size = broken
      ? "width: 260px; height: 72px;"
      : deleted
        ? "width: 220px; height: 64px;"
        : "width: 140px; height: 36px;";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture — Locator repair</title>
<style>
  * { margin: 0; }
  body { background: #ffffff; font-family: Arial, sans-serif; padding: 24px; }
  #hero {
    width: 240px; height: 120px; margin-bottom: 24px;
    background: #3366cc; color: #ffffff;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }
  button {
    ${size}
    font-size: 16px;
    background: #2e7d32; color: #ffffff; border: 0;
  }
</style>
</head>
<body>
  <div id="hero">Hero</div>
  <section id="${panel}">
    <button id="${key}" data-testid="${key}" role="button" aria-label="${name}">${label}</button>
  </section>
</body>
</html>`;
  }

  const background = variant === "changed" ? "#cc3333" : "#3366cc";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture</title>
<style>
  * { margin: 0; }
  body { background: #ffffff; font-family: Arial, sans-serif; }
  #hero {
    width: 240px; height: 120px; margin: 24px;
    background: ${background}; color: #ffffff;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }
</style>
</head>
<body>
  <div id="hero">Hero</div>
</body>
</html>`;
}

export interface FixtureServer {
  url: string;
  setVariant: (variant: Variant) => void;
  close: () => Promise<void>;
}

/** Start the fixture server on an ephemeral port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  let variant: Variant = "default";

  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html(variant));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/`,
    setVariant: (v) => {
      variant = v;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
