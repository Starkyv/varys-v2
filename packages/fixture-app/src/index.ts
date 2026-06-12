import { createServer } from "node:http";

/**
 * Deterministic in-repo target app. It stands in for "the app under test" so
 * record/replay/diff tests never depend on a real external site or the network.
 * Static, no animations, fixed content — so screenshots are byte-stable.
 */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Varys Fixture</title>
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
  <div id="hero">Hero</div>
</body>
</html>`;

export interface FixtureServer {
  url: string;
  close: () => Promise<void>;
}

/** Start the fixture server on an ephemeral port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HTML);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
