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
  | "busy";

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
