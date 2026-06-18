# Varys Recorder (browser extension)

Chrome MV3 extension (built with [WXT](https://wxt.dev)) that records visual-regression
tests and saves them to the Varys API. It has **no login of its own** — it reuses the
session cookie from the Varys web app, so you must be signed in to the matching web
origin in the same browser profile.

## The one thing to understand: the API URL is baked in at build time

The extension talks to a single API, chosen when you build it via the `WXT_API_BASE`
env var (`apps/extension/entrypoints/background.ts`):

```ts
const API_BASE = import.meta.env.WXT_API_BASE ?? "http://localhost:4000";
```

- **No env var** → defaults to `http://localhost:4000` → a **local** build.
- `WXT_API_BASE=https://varys.datagenie.ai` → a **prod** build.

You can't switch at runtime — a given installed extension only ever talks to the API it
was built for. So you build the variant you need and load that one.

The sign-in marker reads the API host's `…better-auth.session_token` cookie by **suffix**,
so it works in both environments (the cookie is `better-auth.session_token` locally and
`__Secure-better-auth.session_token` on prod HTTPS).

---

## Local development

You're pointing the extension at your own machine (`http://localhost:4000`).

**Prerequisites:** the local stack is running (`pnpm dev` → API on `:4000`, web on `:5174`),
and you're signed in at **http://localhost:5174** in the same Chrome profile.

**Option 1 — hot-reload dev loop (recommended while developing the extension):**
```sh
pnpm --filter @varys/extension dev
```
WXT launches a browser with the extension auto-loaded and reloads it on every edit.

**Option 2 — build + load into your normal Chrome:**
```sh
pnpm --filter @varys/extension build      # no env var → targets localhost:4000
```
Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `apps/extension/.output/chrome-mv3/`.

---

## Production (the hosted app)

You're building the version your team installs, pointing at the hosted API.

**Prerequisite for users:** signed in at **https://varys.datagenie.ai** with a
`datagenie.ai` Google account (the domain restriction), in the same Chrome profile.

**Build + package into a shareable zip:**
```sh
WXT_API_BASE=https://varys.datagenie.ai pnpm --filter @varys/extension exec wxt zip
```
Output:
- folder: `apps/extension/.output/chrome-mv3/`
- zip (share this): `apps/extension/.output/varysextension-0.0.0-chrome.zip`

**Install (forward to teammates):**
1. Unzip `varysextension-0.0.0-chrome.zip`.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the
   unzipped folder.
3. Sign in at https://varys.datagenie.ai, then click the Varys icon — the marker should
   show **Online**.

---

## Quick reference

| Goal | Command |
|---|---|
| Local hot-reload dev | `pnpm --filter @varys/extension dev` |
| Local build | `pnpm --filter @varys/extension build` |
| Prod build + zip | `WXT_API_BASE=https://varys.datagenie.ai pnpm --filter @varys/extension exec wxt zip` |
| Type-check | `pnpm --filter @varys/extension typecheck` |

Build artifacts land in `apps/extension/.output/` (git-ignored).

## Gotchas

- **Don't run a local build and a prod build at the same time** — both match every page,
  so you'd get two icons/panels. Load whichever you need; remove/disable the other.
- **Building clobbers `.output/`.** A local `build` overwrites the prod artifacts (and
  vice-versa). Rebuild the variant you want before sharing.
- **Load-unpacked has no auto-update.** After a rebuild, hit the **↻ refresh** on the
  extension's card in `chrome://extensions` (if you loaded from `.output/chrome-mv3/`),
  or re-load the new folder. Teammates need the new zip re-shared.
- **"Offline" / a save fails** → you're not signed in to the matching web origin
  (localhost:5174 for local, varys.datagenie.ai for prod) in this Chrome profile.
- The extension ID differing per install is fine — the API accepts any
  `chrome-extension://` origin and the cookie is matched by host, not by extension ID.
