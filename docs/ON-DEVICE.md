# Running mmdrome on a real host, and seeing what it did

One command, on any machine: **`npm run device`**. It picks the host this machine
can actually drive, builds the artifact that host needs, launches it, and tells
you where the logs and the push report come from.

```sh
npm run device                     # auto: macOS+Xcode → iOS simulator, everywhere else → web
npm run device -- --web            # build + serve the PWA on your Wi-Fi (open it on the phone)
npm run device -- --web --fixtures # …and serve a local Navidrome + WebDAV to talk to
npm run device -- --web --drive    # run the scripted real-server exercise and print the report
npm run device -- --ios            # macOS only: build, install and launch on an iOS simulator
npm run device -- --ios --device <udid>   # a physical iPhone (needs a build signed once in Xcode)
npm run device -- --help           # the same list, from the tool
```

## Before the first run

- Node 20+ and one `npm install` in the repo. That is enough for `--web`.
- `--drive` also needs a Playwright browser: `npx playwright install chromium`
  (CI installs it with `--with-deps`).
- iOS needs macOS with Xcode. A physical iPhone additionally needs a build
  signed once in Xcode — see the iOS section below for the one step this tool
  deliberately does not do for you.

Nothing is dropped for not being available here: if you ask for `--ios` on a
machine without Xcode, the command says so, prints the SideStore source the
phone installs from, and points at the web host. The native app is compiled by
CI (`ios.yml`) either way.

## Web (any OS — this is also the phone path)

1. `npm run device -- --web --fixtures`
2. It prints two URLs. Open the app URL on the phone (same Wi-Fi; `?debug` is
   already on it) — this is the real production bundle, so "installing" it is
   the browser's own Add to Home Screen. Then put the printed **Navidrome URL**
   and **WebDAV URL** into Settings → Sources (any credentials; the fixtures
   accept all) and press **Connect & Load Songs**. Two songs are served, named
   `Song One` / `Song Two`.
3. Scan, rate, push — the whole flow, against a real local server.
4. Logs and the push report: **Settings → About → Debug HUD → Copy**. That dump
   is the same payload users paste into a bug report: `lastPushReport` (per-row
   disposition, the precondition rung the server accepted), the metadata-scan
   state, and the JS event ring. It is also on `window.__debugHudText`.
   For verbose scan/push lines, open the app with `?debug=tags,sync`.

Without `--fixtures`, `--web` still serves the real bundle on the LAN — use that
when the phone should talk to *your* Navidrome/WebDAV.

## `--drive`: the same thing, done for you

`npm run device -- --web --drive` runs `tests/e2e/realservers.spec.ts`: the
production bundle, driven through the real UI, against **real `node:http`
servers** (real `PROPFIND` XML, real Range reads, real conditional MOVE) — not
the route mocks the rest of the suite uses. It prints, per spec:

- the scan result (a pending song with no file linked by the scan),
- the server's own request counters (`put`/`move`/`412` — "one upload, no
  re-upload" is an assertion, not a claim),
- **the app's push report**, read out of its Debug HUD dump,

and writes `test-results/on-device-<spec>.json` (console + the full dump)
alongside it.

`--drive` needs port 4173 free, because the spec builds and serves its own
bundle there; if something is already listening the command refuses and exits
rather than reporting a build it did not make. Stop that server first (for the
`--web` host you can instead pass `--port <other>`).

This is the closest thing to a device run available without hardware; it is
still not a device. iOS-only behaviour (background audio, lock screen, Keychain
credentials) has to be judged on a phone.

## iOS (macOS with Xcode only)

1. `npm run device -- --ios` — finds or boots an iPhone simulator, builds
   `ios/App/App.xcodeproj` for it, installs, then launches with the console
   attached: native **and** JS log lines stream into your terminal until Ctrl+C.
2. `npm run device -- --ios --device <udid>` — installs the built app on a
   connected iPhone and streams its console. A physical device needs a signing
   identity, which this tool deliberately does not invent: open
   `ios/App/App.xcodeproj` in Xcode once, pick your team, Run. After that the
   command reinstalls and streams.
3. No Mac? Install from the release: add
   `https://sieradni.github.io/mmdrome/sidestore/apps.json` to SideStore (see
   [README §iOS app](../README.md#ios-app-sidestore)).

The push report on iOS comes from the same place as on the web — Debug HUD →
Copy; the terminal only carries the native console.

## What this does not replace

- The e2e suite (`npm run test:e2e`) — it still owns the mocked, deterministic
  matrices (queue, playback, thumbnails, EQ). Use `--drive` for the
  server-facing behaviour.
- Release verification. A green `--drive` is not a shipped release; the release
  procedure is [RELEASING.md](RELEASING.md).
