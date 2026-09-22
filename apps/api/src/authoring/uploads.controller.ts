import type { IncomingHttpHeaders } from "node:http";
import { BadRequestException, Controller, Headers, Post, Req, Res } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { McpAuthService, McpUnauthorized } from "./mcp-auth.service";
import { UploadsService } from "./uploads.service";

/**
 * `POST /mcp/uploads` — hand Varys a screenshot without sending it through the model.
 *
 * It lives under `/mcp` on purpose, and not for tidiness: that prefix is already routed to the API
 * by the Vite dev proxy and by the Ingress, so this adds no new top-level path to keep in sync
 * (the gotcha in CLAUDE.md), and it authenticates with the very same bearer token the MCP client
 * already holds. The agent's shell uploads; the agent's tool call then names the handle.
 *
 * `@Public()` exempts it from the COOKIE guard only, exactly as `/mcp` itself is exempt — the
 * uploader is a terminal, not a browser. It is not unauthenticated: every request resolves a real
 * principal through the same `McpAuthService`, and the handle it mints is redeemable only by that
 * principal.
 */
/** The slice of the HTTP response we touch — express types are only available transitively via
 *  @nestjs/platform-express, so `McpController` declares the same shims rather than depend on them. */
interface HttpRes {
  status(code: number): unknown;
}

/**
 * The slice of the HTTP request we touch: the unread body, as a stream.
 *
 * Read here rather than by a globally-registered raw body parser, for two reasons that both
 * matter. A parser keyed on content type would change how EVERY route treats those types, to
 * serve one endpoint; and it would live in `main.ts`, which the E2E suite does not run — so the
 * route would behave one way in production and another under test, which is the kind of
 * difference that gets discovered in production.
 */
interface HttpReq extends AsyncIterable<Buffer> {
  socket?: { destroy(): void } | undefined;
}

/** The ceiling on one upload. A screenshot is a few hundred KB; this is the guard against a
 *  stream that never ends, and it is enforced as the bytes arrive rather than after. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Collect the request body, refusing rather than buffering without bound. */
async function readBody(req: HttpReq): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) {
      req.socket?.destroy();
      throw new BadRequestException(
        `That upload is past the ${MAX_UPLOAD_BYTES}-byte limit for a screenshot. A capture is a few hundred KB — check you are sending the PNG and not something else.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

@Controller("mcp")
export class UploadsController {
  constructor(
    private readonly mcpAuth: McpAuthService,
    private readonly uploads: UploadsService,
  ) {}

  @Public()
  @Post("uploads")
  async upload(
    @Headers() headers: IncomingHttpHeaders,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ): Promise<{ imageRef: string; bytes: number } | undefined> {
    let ownerId: string;
    try {
      ownerId = (await this.mcpAuth.principal(headers)).id;
    } catch (err) {
      if (!(err instanceof McpUnauthorized)) throw err;
      res.status(401);
      return undefined;
    }

    const body = await readBody(req);
    if (body.length === 0) {
      throw new BadRequestException(
        "POST the PNG's raw bytes with `Content-Type: image/png` (curl: `--data-binary @shot.png`). This endpoint takes the file itself, not JSON and not base64 — sending base64 here would reintroduce the encoding step it exists to remove.",
      );
    }

    const imageRef = this.uploads.put(ownerId, body);
    // The bytes are NOT validated here. `decodePng` does that when the ref is redeemed, so the
    // signature, IEND and sha256 checks stay in exactly one place and a screenshot cannot reach
    // storage down a path that skipped them.
    return { imageRef, bytes: body.length };
  }
}
