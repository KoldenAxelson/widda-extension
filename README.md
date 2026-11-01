# Widda Extension (Chrome, Manifest V3)

**License: MIT** (see `LICENSE`). The extension is open-source — its build is the
deterministic esbuild bundle (`make build:ext`), so anyone can rebuild from source and
verify the published artifact. This transparency is deliberate (shopping extensions have a trust problem):
adapters are non-destructive and never overwrite existing affiliate attribution.

TypeScript bundled to plain JS with the standalone **esbuild** binary — no npm,
no Node, no `node_modules`, consistent with the project's no-npm constraint
(see `docs/tech-stack.md`). esbuild transpiles and bundles; it does **not**
type-check (it strips types). `tsconfig.json` is kept only for optional editor
IntelliSense.

## Build
```sh
make tools:ext   # one-time: installs the esbuild binary via `go install`
make build:ext   # bundles src/{background,content,popup}.ts -> dist/ (IIFE)
make dev:ext     # rebuild on change
```
`tools:ext` puts esbuild in `$(go env GOPATH)/bin`; make sure that's on your PATH.

### Standalone (without the Widda monorepo)
The `make` targets live in the private monorepo. From this folder alone, with
[esbuild v0.24.2](https://esbuild.github.io/getting-started/#download-a-build)
on your PATH (or `go install github.com/evanw/esbuild/cmd/esbuild@v0.24.2`):
```sh
esbuild src/background.ts src/content.ts src/popup.ts \
  --bundle --format=iife --target=es2022 --outdir=dist --sourcemap \
  --define:__DEV__=false --minify
```
This is the same command used for the Chrome Web Store build, so the output in
`dist/` should match the published package's `dist/` byte-for-byte.

## Load unpacked
1. Build (`make build:ext`).
2. Chrome → `chrome://extensions` → enable Developer mode.
3. "Load unpacked" → select this `extension/` folder.

## UI preview (no Chrome needed)
Iterate the popup + content-script visuals in a plain browser:
```sh
make preview:ext     # bundles preview/preview.js
# then open extension/preview/index.html
```
It renders the real banner/toast (from `src/ui.ts`) over a faux checkout page, plus
a static popup replica using the shared `popup.css`. Handoff-friendly for a designer.

## Layout
- `manifest.json` — MV3 manifest. `host_permissions` and `content_scripts.matches`
  must enumerate every supported domain (kept in sync with the `sites` table).
- `src/background.ts` — service worker: OAuth, sub-sync, promo-map cache, cookie injection.
- `src/content.ts` — priority-queue walk; dismiss persistence (24h per site).
- `src/ui.ts` — promo banner + toast (chrome-free, so it's previewable).
- `src/popup.ts` + `popup.html` + `popup.css` — sign-in, ranked list, refresh.
- `src/api.ts` — Widda API client. `src/types.ts` — shared storage/API types.

## Configuration
Edit `src/config.ts`:
- `API_BASE` — the Widda API (use `http://localhost:8080` for local dev).
- `GOOGLE_CLIENT_ID` — OAuth client ID from Google Cloud Console (ROADMAP Phase G).

## Google OAuth flow
Sign-in uses `chrome.identity.launchWebAuthFlow` with Google's implicit flow
(`response_type=token id_token`), which returns both an ID token (sent to
`/auth/google`) and a YouTube access token (used for `subscriptions.list`).
The OAuth client's authorized redirect URI must be the value of
`chrome.identity.getRedirectURL()` for the installed extension ID.

Note: periodic background re-sync attempts a non-interactive token refresh; if
Google requires consent it no-ops, and the user can refresh from the popup.
