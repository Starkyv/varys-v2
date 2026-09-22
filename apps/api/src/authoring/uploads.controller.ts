import type { IncomingHttpHeaders } from "node:http";
import { BadRequestException, Controller, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "../auth/auth";
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
 *
 * There are two ways to be that principal, and they exist for two different callers:
 *
 *  - **`POST /mcp/uploads`** with the OAuth bearer — for anything that actually HOLDS the token:
 *    the E2E suite, a script, a person with curl.
 *  - **`POST /mcp/uploads/:slot`** with no header at all — for the AGENT, which holds no token
 *    (its MCP client does) and therefore could never use the route above. The slot is minted by
 *    an authenticated tool call and resolves to that same principal, so this is the same identity
 *    arriving by a different door, not a way in without one.
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
  /**
   * `@Inject` on every parameter, as every other controller here does — and it is load-bearing,
   * not house style.
   *
   * The deployed image runs the TypeScript sources directly under `tsx` (see `Dockerfile.app`),
   * and esbuild does not implement `emitDecoratorMetadata`. With no `design:paramtypes` to read,
   * Nest concludes this constructor takes NO dependencies and instantiates it with none — leaving
   * both properties `undefined` and raising nothing at boot. The failure surfaces later, as a 500
   * on the first request that touches one, which is how this route shipped broken and stayed that
   * way: the E2E suite transforms with swc (`unplugin-swc`), which DOES emit the metadata, so the
   * tests inject correctly and prove nothing about production.
   */
  constructor(
    @Inject(McpAuthService) private readonly mcpAuth: McpAuthService,
    @Inject(UploadsService) private readonly uploads: UploadsService,
  ) {}

  @Public()
  @Post("uploads")
  async upload(
    @Headers() headers: IncomingHttpHeaders,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ): Promise<{ imageRef: string; bytes: number } | undefined> {
    const ownerId = await this.ownerOf(headers);
    if (!ownerId) {
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

  /**
   * The same upload, addressed by CAPABILITY — the route an agent can actually reach.
   *
   * No `Authorization` header is read, and that is the design rather than a relaxation: the slot
   * in the path was minted by an authenticated tool call and carries that call's principal, so
   * the identity is exactly as strong as the one above. What it removes is the requirement to
   * hold a token in a shell that never had one.
   *
   * The slot is NOT consumed. An agent captures several states per walk and re-mints on every
   * tool response anyway; making the URL single-use would only force a round trip before each
   * capture. The single-use property lives on the handle this returns, which is the thing that
   * must bind to exactly one checkpoint.
   */
  @Public()
  @Post("uploads/:slot")
  async uploadToSlot(
    @Param("slot") slot: string,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ): Promise<{ imageRef: string; bytes: number } | undefined> {
    const ownerId = this.uploads.slotOwner(slot);
    if (!ownerId) {
      // Unknown and expired read the same, for the reason a handle's failures do: they are both
      // "this is not your URL", and an oracle that told them apart would only help a guesser.
      res.status(401);
      return undefined;
    }

    const body = await readBody(req);
    if (body.length === 0) {
      throw new BadRequestException(
        "POST the PNG's raw bytes with `Content-Type: image/png` (curl: `--data-binary @shot.png`). This endpoint takes the file itself, not JSON and not base64 — sending base64 here would reintroduce the encoding step it exists to remove.",
      );
    }
    return { imageRef: this.uploads.put(ownerId, body), bytes: body.length };
  }

  /**
   * Who is uploading — by OAuth bearer, or by the web session cookie.
   *
   * The bearer is the agent's own credential and the obvious route. The COOKIE matters just as
   * much, and for a reason worth stating: Claude Code keeps its OAuth tokens in the OS keyring,
   * not in a file, so an agent asked to `curl` this endpoint cannot reach its own token — it is
   * authenticated to Varys and unable to prove it to anything but its own MCP client. Without the
   * cookie route the only person who could upload would be one who already had a token in hand,
   * which in practice is nobody.
   *
   * Both resolve to the same `user.id`, which is what makes them interchangeable here: a handle
   * minted in a browser is redeemable by that person's own agent, and by nobody else's.
   */
  private async ownerOf(headers: IncomingHttpHeaders): Promise<string | null> {
    if (headers.authorization) {
      try {
        return (await this.mcpAuth.principal(headers)).id;
      } catch (err) {
        if (!(err instanceof McpUnauthorized)) throw err;
        return null;
      }
    }
    const session = await getAuth()
      .api.getSession({ headers: fromNodeHeaders(headers) })
      .catch(() => null);
    return session?.user?.id ?? null;
  }
}
