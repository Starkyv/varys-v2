import { createServer } from "node:http";

/**
 * Deterministic in-repo target app. It stands in for "the app under test" so
 * record/replay/diff tests never depend on a real external site or the network.
 * Static, no animations, fixed content — so screenshots are byte-stable.
 *
 * `setVariant` lets a test change what the same URL renders, so one test can
 * seed a baseline and then produce a visual diff on a later run.
 */
export type Variant = "default" | "changed" | "login";

function html(variant: Variant): string {
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
