# baton desktop

Electron 45 / Node 24 desktop app for macOS and Windows. It loads the existing web console and drives the agent CLIs installed on the user's machine; installing baton does not install Claude Code, Codex, pi, or gh.

## Develop

From the repository root, with Node 24 and dependencies installed:

```sh
npm run build:desktop
npm run desktop
```

`npm run dev -w @baton/desktop` builds the server and desktop TypeScript, watches desktop TypeScript, and launches Electron against the existing `packages/web/dist`. Relaunch Electron to apply main/preload changes. Tests and experiments must use a temporary data directory; the normal app and CLI share `~/.baton`.

```sh
BATON_HOME="$(mktemp -d)" BATON_DESKTOP_PORT=17433 npm run desktop
```

For Vite live reload, start Vite with a matching daemon proxy URL in one terminal and the app in another:

```sh
BATON_WEB_PROXY_URL=http://127.0.0.1:17433 npm run dev:web
# Second terminal, reusing the same temporary directory across launches:
BATON_HOME=/absolute/path/to/temporary-home BATON_DESKTOP_PORT=17433 BATON_DESKTOP_WEB_URL=http://127.0.0.1:5173 npm run desktop
```

The development URL accepts loopback HTTP only and is ignored in packaged apps. `BATON_DESKTOP_USER_DATA` can isolate Electron/Chromium preferences for automated runs. These are process environment variables, not production configuration options in the UI. PowerShell syntax differs: assign `$env:BATON_HOME` etc. before running npm.

## Build and package

```sh
npm run build -w @baton/desktop
npm run dist:mac -w @baton/desktop
npm run dist:win -w @baton/desktop
```

Outputs are in `packages/desktop/release/`: macOS DMG and ZIP for arm64 and x64; Windows NSIS EXE and ZIP for x64. The build is unsigned, with macOS hardened runtime disabled. The first package build downloads platform Electron binaries and builder tools. CI in `.github/workflows/desktop.yml` builds on native macOS and Windows runners (manual dispatch or a `desktop-v*` tag); it does not publish releases.

`scripts/stage.mjs` traverses the installed production dependencies, including required peers, preserving nested npm resolution paths. It copies built server, protocol, providers, web, licenses, and a dependency manifest into `staging/runtime`. Workspace dependencies become portable directory copies rather than OS-specific symlinks. Electron copies this tree outside `app.asar`, so the daemon's ESM, worker files, SDK resources, and web assets work with Node APIs. No npm install is required on the end user's machine. The Claude Agent SDK is included; its optional bundled CLI binaries (about 220 MB per architecture) are omitted because the adapter explicitly supplies the user's CLI executable. No other runtime dependency is added for the desktop app.

Simple placeholder SVG, PNG, ICO and ICNS assets are checked in. `scripts/icons.mjs` regenerates them deterministically without external image tools.

On macOS, drag baton.app from the DMG into Applications. For a trusted unsigned build downloaded from the internet, remove quarantine if Gatekeeper blocks it:

```sh
xattr -dr com.apple.quarantine /Applications/baton.app
```

On Windows, run the NSIS installer or extract the ZIP and run baton.exe. An unsigned download may trigger SmartScreen; use **More info → Run anyway** only for a build you trust. Windows packages can be cross-built on macOS when builder downloads/tools are available; native Windows CI remains the required check for execution, installer behavior, tray/overlay, CLI `.cmd` launch, and notifications. No physical Windows runtime verification was performed on this macOS development host.

## Daemon and app lifecycle

The app reads `$BATON_HOME/daemon.json` and `$BATON_HOME/token`, then checks authenticated `/api/info`, including daemon identity, port, and home. If an existing CLI daemon is healthy, it connects and does not stop it on app exit. Otherwise it starts the bundled CLI using Electron's Node runtime, `ELECTRON_RUN_AS_NODE=1`, `serve --notifications client --exit-on-stdin-close`, and `BATON_SPAWNED_BY=desktop`. The server chooses an available port and the app reads the actual address from daemon.json. Spawned daemon output appends to `$BATON_HOME/desktop-daemon.log` (0600).

macOS captures `$SHELL -ilc 'env -0'` once with a five-second timeout and passes the login environment to the daemon. This makes nvm-installed agent CLIs available when opened from Finder. Explicit BATON variables are preserved. Shell failure falls back to the inherited environment. Windows inherits its system/user PATH.

Closing a window keeps the app and daemon running; reopen from the macOS Dock or Windows tray. **Quit baton** asks for confirmation while active or paused Runs exist, then gracefully stops only the app's child daemon (SIGTERM on macOS; stdin close on Windows). Unexpected child exits restart with exponential backoff. A second app instance focuses the existing window. Bounds are restored only when visible on a connected display.

The app subscribes to inbox SSE and periodically fetches the inbox for its Dock badge / Windows taskbar overlay. It subscribes to notification SSE for native notifications; clicks focus and route to the inbox or a Run. Old daemons returning 404 are retried with backoff. The app also retries startup once without the new CLI flags only when an older CLI rejects an unknown option immediately; native notification functionality may then be unavailable. When attaching to a daemon running in `os` notification mode, the daemon can also emit its own notifications; start the shared daemon with `--notifications client` to avoid duplicate OS delivery.

## Data and security

- Shared daemon state: `~/.baton` on macOS; `%USERPROFILE%\.baton` on Windows; override with `BATON_HOME`.
- Electron preferences/window state: `~/Library/Application Support/baton` on macOS; `%APPDATA%\baton` on Windows.
- Context isolation and renderer sandbox are enabled; Node integration and webviews are disabled. Navigation stays on the console origin; HTTP(S)/mailto external links use the system browser. Permission requests are denied; native notifications run in the main process.
- The preload exposes exactly `platform`, `version`, `pickDirectory`, `openExternal`, `showItemInFolder`, and `setBadgeCount`. IPC validates the main-frame sender, directory options, absolute paths, count and external URL scheme.
- Add Project and New Run's Add Project use the system folder picker and register the selected directory. Manual input and the original directory browser are under “其他方式”. Project menus can reveal the folder in Finder/Explorer. Browser mode stays available without the bridge.

## Verify

```sh
npx vitest run packages/desktop/src packages/web/src/components/Projects.test.tsx
npm run typecheck
npm run smoke -w @baton/desktop
```

The smoke runner creates a temporary `BATON_HOME` and Chromium profile, uses a random free port and fake agents, checks authenticated `/api/info`, real console rendering, the exact preload surface, absence of renderer Node, IPC URL rejection, notification route loading, window close/reopen while daemon stays alive, and graceful daemon stop after Quit. It retains a JSON report in the temporary directory. It never touches the production daemon or port 6767.

To verify the staged app rather than the development entry:

```sh
BATON_DESKTOP_EXECUTABLE="$PWD/packages/desktop/release/mac-arm64/baton.app/Contents/MacOS/baton" npm run smoke -w @baton/desktop
```

The smoke does not interact with the physical folder picker or system notification center. Those OS interactions, signed distribution/notarization, automatic updates, and Windows execution still need platform acceptance testing.
