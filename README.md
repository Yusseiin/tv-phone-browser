# Phone Browser

A full web browser for a Samsung (Tizen) TV that you drive from your phone instead of the remote. It runs as a [TizenBrew](https://github.com/reisxd/TizenBrew) module, so there is nothing to sign or sideload.

On the phone you get:

- an address bar (URLs or search) with back, forward, reload, home and zoom
- a trackpad with a pointer on the TV: drag to move, tap to click, two fingers to scroll, tap-then-drag to hold the button
- your phone's keyboard: tap a text field on the TV and type on the phone, Enter submits
- a live preview of the TV screen that you can tap directly
- pickers for drop-downs, and answers for `alert`/`confirm`/`prompt` dialogs
- video controls: play/pause, ±10 s, fullscreen
- tabs: links meant for a new tab open as a tab, and pop-ups (ads, mostly) are kept as background tabs or blocked, so they never take over the TV
- bookmarks, shown on the phone and on the TV home screen

## How it works

```
 Phone (any browser)                       Samsung TV
┌───────────────────┐  Wi-Fi, port 8765  ┌──────────────────────────────────────────┐
│ remote web page   │ ─────────────────▶ │ service (Node, run by TizenBrew)          │
└───────────────────┘                    │   │ DevTools protocol     │ WebSocket       │
                                         │   ▼                       ▼                 │
                                         │ TizenBrew window: any website + agent.js  │
                                         └──────────────────────────────────────────┘
```

TizenBrew launches its window in debug mode and injects `dist/agent.js` into every page. The agent draws the pointer, shows the TV home screen and pairing code, and reports which field has focus. It also stops every attempt to open a second window (`target="_blank"` links, `window.open`, pop-unders, pop-ups from ad frames) and hands it to the service, which keeps the tab list.

`dist/service.js` runs on the TV. It serves the phone remote and drives the page in one of two modes, shown at the top of the phone screen:

- **Direct control** (normal): the service attaches its own DevTools session to the TizenBrew window. Clicks and keys are real input events, the screen preview works, and sites with strict security policies still work.
- **Compatibility mode** (fallback): used if the TV refuses a second DevTools session. The agent replays input as DOM events. Most sites work, but the screen preview is off, fullscreen video is emulated, sites whose CSP blocks local connections can't be controlled, and Back follows the window's history even across tabs.

## Install

You need TizenBrew already installed on the TV, and the phone on the same network as the TV.

1. **The module is published at [github.com/Yusseiin/tv-phone-browser](https://github.com/Yusseiin/tv-phone-browser).** TizenBrew downloads `package.json`, `dist/agent.js` and `dist/service.js` straight from there through jsDelivr, which is why `dist/` is committed. (In a fork, use your own `<user>/<repo>` in the steps below.)
2. **Add the module on the TV.** Open TizenBrew, press the green button for the module manager, choose **Add GitHub Module** and enter `Yusseiin/tv-phone-browser`.
3. **Open "Phone Browser"** from the TizenBrew list. The TV shows a home screen with an address and a QR code.
4. **On the phone**, scan the QR code or open `http://<TV-IP>:8765`. Tap through to the pairing screen; a 4-digit code appears on the TV. Enter it once and the phone stays paired.
5. Optional:
   - Add the page to the phone's home screen so it opens like an app.
   - In TizenBrew settings, set Phone Browser as the **autolaunch** module and add it to **autolaunch services**. The service then starts with TizenBrew and the phone can connect right away.

## Using the remote

| On the phone | On the TV |
| --- | --- |
| Drag one finger | Move the pointer (faster flicks go further) |
| Tap / double-tap | Click / double-click |
| Tap, then tap again and drag | Press and hold: sliders, text selection, drag and drop |
| Two-finger drag, or the strip on the right edge | Scroll whatever is under the pointer |
| Screen button (top right) | Live preview. Tap the image to click there, drag to scroll |
| Text box at the bottom | Replaces the text of the focused TV field as you type. ⏎ presses Enter |
| Keyboard button | Extra keys: ⌫, Tab, Esc, Space, arrows, Page Up/Down |
| Tab counter (next to Go) | Tab list: switch, close, open a new tab, close all others |
| Pop-up notice | A page opened a pop-up. **Show** switches to it, **Close** drops it |

### Tabs and pop-ups

The TV has a single window, so tabs live on the phone: the active tab is what the TV shows, and switching loads that tab's page again (like opening a bookmark).

- A link meant for a new tab opens as a new tab. Back on its first page closes it and returns to the tab you came from.
- A pop-up the page opens by itself becomes a background tab and the phone shows a notice. Repeats of the same pop-up are ignored, and a burst of more than 5 in 10 seconds is cut off.
- **Settings → Pop-ups → Block** drops them instead; the notice then offers **Open** in case you wanted it.
- Tabs are kept on the TV and come back when TizenBrew restarts.

The TV remote still works too: **Back** works like the phone's Back button (from the home screen it returns to TizenBrew), and the media keys control the video on the page.

## Updating

Change files in `src/`, run `npm run build`, commit, push. jsDelivr caches GitHub files: about 12 hours for a branch, and up to 7 days once the repo has release tags. To get an update onto the TV sooner, purge these URLs with jsDelivr's purge tool (jsdelivr.com/tools/purge) and restart TizenBrew:

```
https://cdn.jsdelivr.net/gh/Yusseiin/tv-phone-browser/package.json
https://cdn.jsdelivr.net/gh/Yusseiin/tv-phone-browser/dist/agent.js
https://cdn.jsdelivr.net/gh/Yusseiin/tv-phone-browser/dist/service.js
```

## Troubleshooting

- **The phone can't open `http://<TV-IP>:8765`**: the service isn't running. Open Phone Browser from TizenBrew (that starts it), or enable it under autolaunch services. TizenBrew's home screen reports crashed services.
- **The TV home screen says "Starting the remote service…" and stays there**: same cause. Also check that the TV has internet access, because TizenBrew downloads the service from jsDelivr.
- **The phone says "Compatibility mode"**: the service couldn't attach to DevTools. Open **Settings → Diagnostics** on the phone. `devtools.lastError` and the log explain why, and `http://<TV-IP>:8765/api/status` shows the same information.
- **A site renders badly**: the TV's built-in engine is old (a Chromium 76-based engine on 2021 models), the same one the stock browser uses. Some sites also serve a TV layout because of the user agent; TizenBrew's **User Agent** setting can change that.

## Development

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

```bash
npm run dev
```

- `npm run build` writes `dist/agent.js` (transpiled for Chromium 47) and `dist/service.js` (transpiled for Node 4.4, with the phone UI inlined). Edit `src/`, never `dist/`.
- `npm test` runs the discovery unit tests, then the end-to-end suite twice, once per control mode. A headless Chrome plays the TV, and the agent is injected exactly the way TizenBrew does it.
- `npm run dev` starts the same simulated TV for manual testing. The TV screen is at http://127.0.0.1:8767 and the phone remote at http://127.0.0.1:8765. The pairing code appears on the TV view.

Layout:

```
src/service/   Node service: HTTP + WebSocket server, pairing, DevTools control
src/agent/     script injected into every page on the TV
src/remote/    phone web app (inlined into the service at build time)
test/          simulator, unit and end-to-end tests
```

Paired phones, bookmarks, tabs and the pop-up setting are stored on the TV in `/home/owner/share/tvPhoneBrowser.json`, next to TizenBrew's own config.
