import { Card, Spinner } from "@varys/ui";
import { useEffect } from "react";
import styles from "./styles.module.scss";

/** The SPA path better-auth's MCP `authorize` endpoint sends an unauthenticated browser to. */
export const MCP_AUTHORIZE_PATH = "/oauth/authorize";

/** True when the browser is on the MCP OAuth handoff route. */
export function isMcpAuthorizeRoute(): boolean {
  return window.location.pathname === MCP_AUTHORIZE_PATH;
}

/**
 * The handoff step of Claude Code's OAuth flow (Slice 16 — per-user MCP auth).
 *
 * Claude Code sends the browser to `/api/auth/mcp/authorize?…`. With no Varys session,
 * better-auth redirects here (its `loginPage`) carrying the original OAuth query intact;
 * `<SessionGate>` shows the normal Login screen first, so this component only mounts once
 * the user is signed in. Its whole job is to hand the same query BACK to the authorize
 * endpoint, which now sees a session and can issue the code Claude Code is waiting for.
 *
 * A full-page `replace` (not a fetch) is required: the endpoint answers with a 302 to the
 * client's loopback `redirect_uri`, which the browser must follow itself.
 */
export function McpAuthorize() {
  useEffect(() => {
    // Forward the OAuth query verbatim — client_id, redirect_uri, state, PKCE challenge.
    // Dropping any of it would fail the flow, so nothing here is reinterpreted.
    window.location.replace(`/api/auth/mcp/authorize${window.location.search}`);
  }, []);

  return (
    <div className={styles.screen}>
      <Card className={styles.card}>
        <Spinner size={24} label="Connecting Claude Code" />
        <p className={styles.hint}>
          Authorizing Claude Code to author tests as you. You'll be returned to your terminal
          in a moment.
        </p>
      </Card>
    </div>
  );
}
