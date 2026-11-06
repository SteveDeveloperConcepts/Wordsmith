# Wordsmith browser extension

Live underlines for text you write in the browser, for Chrome and Edge (Manifest V3). It runs the same checking
engine as the desktop app. Your text never leaves your computer.

It checks Outlook on the web and Gmail from install. Any other site is off until you turn it on from the toolbar
popup, one site at a time.

## What cannot work

- **Google Docs.** Docs draws its text on a canvas. The page has no text for an extension to read or underline.
- **Word for the web.** Word uses its own editing surface, so it gets no live underlines either. The popup says so on
  both rather than offering a switch that would do nothing.
- **Other editors that draw their own text**, for the same reason: Google Sheets and Slides, and the other Office web
  apps.
- **Desktop apps.** An extension only runs in the browser. It does not reach Word, classic Outlook, or the new Outlook
  for Windows, even though that one is built from web technology.
- **Browser pages.** Browsers do not let extensions run on `chrome://` and `edge://` pages or on their extension
  stores.

For anything on this list, paste the text into the Wordsmith app.

Some limits are by design or are not solved yet:

- English only. The engine has no other language, so text in another language will collect a lot of underlines.
  Turn the site off for those messages.
- Suggestions open with a mouse. There is no keyboard way to reach a card.
- Password, email, search, and other special input types are never read. Neither are text inputs a page marks as
  personal details with `autocomplete`, such as a name, an address, or a card number.
- Text in a reply's quoted thread and in a signature is left out by looking for known markers. Those markers come from
  open-source mail tools, not from Microsoft or Google, and can change. An unknown marker means some quoted text gets
  checked. It cannot lose or change anything.
- Underlines in textareas and inputs are drawn on an overlay. If a page scales the field with a CSS transform or zoom,
  the overlay would not line up, so nothing is drawn.

## Install it for development

Build it first, from the repository root:

```
npm run build:extension
```

That writes `dist-extension/`, which is the folder you load.

**Chrome**

1. Go to `chrome://extensions`.
2. Turn on Developer mode, at the top right.
3. Choose Load unpacked and pick the `dist-extension` folder.

**Edge**

1. Go to `edge://extensions`.
2. Turn on Developer mode, on the left.
3. Choose Load unpacked and pick the `dist-extension` folder.

After a rebuild, press the reload button on the extension's card and reload any open pages. Pages open during a
reload keep the old script, which stops working until the page is reloaded.

## Zip it for the stores

Zip the contents of `dist-extension`, so that `manifest.json` is at the top of the archive.

Windows (PowerShell):

```
Compress-Archive -Path dist-extension\* -DestinationPath wordsmith-extension.zip -Force
```

macOS:

```
cd dist-extension && zip -r ../wordsmith-extension.zip . && cd ..
```

Upload the same zip to the Chrome Web Store developer dashboard and to Microsoft Partner Center for Edge.

The Chrome Web Store counts website content as user data even when it is only handled on the device, so the listing
still needs its privacy disclosures, a privacy policy, and the Limited Use statement. Review usually takes a few days
and can take a few weeks.

## How it fits together

- `content/` runs in each page. It finds the focused field, reads the writer's own text, draws underlines with the CSS
  Custom Highlight API, and applies fixes. The page's DOM is not changed, apart from one element under `<html>` that
  holds the card, the badge, and the overlay for form fields.
- `background/` is the service worker. It reads the settings, routes each check to the engine, and recreates the
  offscreen document when it is gone. It holds nothing in memory that matters, because the browser stops it when idle.
- `offscreen/` starts `src/engine/worker.ts` once for all tabs, because a service worker cannot start workers and the
  20 MB engine must not load per tab. It closes itself after 10 idle minutes, since the engine holds about 200 MB.
- `popup/` is the toolbar popup.
- `shared/` holds messages, settings, and the site list. Settings and the personal dictionary are in
  `chrome.storage.sync`.

The content security policy for extension pages includes `connect-src 'self'`, so the browser itself stops the engine
from reaching the network. No code here makes a network request in the first place.

## Tests

- `npx vitest run tests/extension` runs the unit tests: boundaries, offsets, geometry, the queue, settings, and the
  manifest.
- `npm run test:extension` builds the extension and drives it in a real Chromium against the local pages in
  `tests/extension/pages`, which imitate the structure of Outlook and Gmail compose bodies. It needs Playwright's
  Chromium, from `npx playwright-core install chromium`, because branded Chrome and Edge no longer side-load from the
  command line. The local test host is added to a temporary copy of the build, never to the shipped manifest. It does
  not visit real mail sites.

## Firefox and Safari

Neither is built. This is what each would need.

**Firefox**

- A new home for the engine. Firefox has no `chrome.offscreen` and no extension service workers, so the background
  script runs as an event page. The engine would run there, and the manifest would declare `background.scripts` next
  to `service_worker`. Event pages unload after a short idle time and take everything in memory with them, so the
  engine's load time of about a second would come back after each idle spell. Whether a worker can run from an event
  page needs testing.
- `browser_specific_settings.gecko` with an extension id and `data_collection_permissions` set to
  `{ "required": ["none"] }`.
- Firefox 149 or later for full `::highlight()` support. `text-decoration` in `::highlight()` arrived in 146.
- A check for host permissions at run time, because users can withhold them, with a way to ask again.

**Safari**

- The same new home for the engine, since Safari has no offscreen documents. In Manifest V3 its background pages are
  not persistent.
- Packaging as a Safari web extension inside an app, through Xcode or the web extension packager in App Store Connect.
  Both need an Apple Developer Program membership.
- Safari 17.2 or later for `::highlight()`, and 16.4 or later for `scripting.registerContentScripts`.
- A change to the form field overlay. Safari ignores `::highlight()` styles combined with `user-select: none`, which
  the overlay uses.
- A different promise about the dictionary. `storage.sync` works in Safari but does not sync.
