# Wordsmith

A private writing assistant for Windows and macOS. It checks grammar, spelling, punctuation, sentences, clarity, engagement, and tone as you write. Your text is checked on your own computer and is not sent anywhere. AI features are optional and use your own Anthropic API key.

Wordsmith works in its own editor, and it also works where you already write:

| Where you write | How Wordsmith works there |
| --- | --- |
| Any desktop app | **Check Anywhere.** Select text, press `Ctrl+Alt+W` (`⌃⌥W` on a Mac), fix it in a small floating window, and choose Replace. |
| Word, PowerPoint, Excel | **Office add-in.** A panel beside your document, on Windows, Mac, and the web. |
| Outlook with a Microsoft 365 or Outlook.com mailbox | **Office add-in.** A panel beside your draft, in classic, new, web, and Mac Outlook. It skips your signature and the quoted thread. |
| Outlook with a Gmail or Yahoo account | **Check Anywhere.** Microsoft does not run add-ins on these accounts. |
| Outlook on the web, Gmail, other sites | **Browser extension.** Live underlines as you type, in Chrome and Edge. |
| Anything else | Copy with formatting, or export to Word, PDF, HTML, Markdown, or plain text. |

## What it checks

- **Correctness:** spelling, grammar, and punctuation, using the open-source [Harper](https://writewithharper.com) engine and Wordsmith's own rules.
- **Clarity:** wordy phrases, passive voice, long sentences, and hard words.
- **Engagement:** overused words and clichés.
- **Delivery:** tone, formality, and inclusive language.

Goals tell it who you are writing for, so that an email to a friend is not held to the standard of a formal report. Insights give you a word count, reading time, readability, vocabulary, and tone for each document. You can dismiss suggestions, turn off rules, and keep a personal dictionary.

With an API key, you can also rewrite a selection, write new text from a prompt, hear how a chosen reader might react, and run a deeper proofread.

## Install

Download the installer from [Releases](https://github.com/SteveDeveloperConcepts/Wordsmith/releases). After that, Wordsmith keeps itself up to date: new versions download in the background and install when you restart it.

- **Windows:** the installer has no publisher certificate yet, so SmartScreen shows "Windows protected your PC" the first time. Choose **More info**, then **Run anyway**.
- **macOS:** drag Wordsmith into Applications and open it. The first time you use Check Anywhere, macOS asks you to allow Wordsmith under **Accessibility**, because it copies and pastes in other apps on your behalf.

Then add the pieces you want:

- [Install the Office add-in](src/addin/INSTALL.md)
- [Install the browser extension](src/extension/README.md)

## Privacy

- Checking runs on your device, in the app, the Office panel, or the extension. No text is uploaded.
- Your documents stay in the app's local storage.
- Text goes to Anthropic only when you use an AI feature, and only the text that feature needs.
- On the desktop, your API key is encrypted with your system's credential protection. It never reaches the app's web page.
- Check Anywhere borrows the clipboard for a moment and puts back what was on it. Corrections are marked so that they stay out of Windows clipboard history.

## What it cannot do

- **No live underlines inside desktop Word or Outlook.** Use the add-in panel, or Check Anywhere.
- **Google Docs and Word for the web draw their own text,** so the extension cannot underline in them. In Word for the web, use the add-in.
- **In Outlook, a fix replaces the draft's body,** because that is the only write Outlook allows. Formatting and images are kept, but you may not be able to undo it with `Ctrl+Z`. The panel says so where that applies.
- **A few apps do not allow copying** or run with higher privileges than Wordsmith. Check Anywhere then offers the clipboard instead. In terminals it uses the clipboard only, because `Ctrl+C` there stops the running program.

## What has been tested

| Part | Tested | Not tested yet |
| --- | --- | --- |
| Desktop app | End to end, packaged, on Windows and on Apple Silicon and Intel Macs. | Signed and notarised Mac builds, until the first release. |
| Updates | On Windows, a real install, update, and restart on every push. | Updates on a Mac, until there are two signed releases. |
| Check Anywhere | On Windows, against test windows in separate processes, with plain and formatted text, and the whole round trip in real classic Outlook and Word. On Macs, its system calls load and answer. | The copy and paste flow on a Mac. |
| Office add-in | In real Chrome against a fake Office. Both manifests pass Microsoft's validator. | Real Office, on any platform. |
| Browser extension | In real Chromium and in the installed Edge, against local copies of Outlook and Gmail's compose areas. | Real Outlook on the web and Gmail. |
| AI features | Against a fake server. | The real Claude API. |

## Build from source

You need Node.js 22 or later.

```bash
npm install
npm run dev        # the desktop app, with hot reload
npm run dev:web    # the same UI in a browser
```

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript |
| `npm run build` | Builds the desktop app into `out/` |
| `npm run test:e2e` | Runs the real desktop app. Add `-- --anywhere` on Windows to test Check Anywhere against test windows of its own. |
| `scripts/anywhere-office-check.ps1` | With Wordsmith running on Windows, checks the Check Anywhere round trip in real Outlook (`-App Outlook`) or Word (`-App Word`): a throwaway draft or document, the shortcut, Fix, and Replace. Nothing is sent or saved. |
| `npm run dist` | Builds the installer for this computer into `release/` |
| `npm run build:site` | Builds the web app and the Office add-in into `dist-site/` |
| `npm run test:addin` | Runs the built add-in in Chrome against a fake Office |
| `npm run build:extension` | Builds the browser extension into `dist-extension/` |
| `npm run test:extension` | Builds the extension and runs it in Chromium against local test pages. `WORDSMITH_BROWSER=msedge` runs it in Edge instead |
| `npm run icons` | Redraws the app icons |
| `npm run release` | Publishes a new version. See [Releasing Wordsmith](docs/RELEASING.md). |

## How it is organized

```
src/engine      The checker: Harper plus Wordsmith's rules. Runs in a web worker.
src/shared      Code used on both sides of the app, including the HTML patching that keeps formatting.
src/main        The Electron shell. src/main/anywhere is Check Anywhere.
src/preload     The narrow bridge between the shell and the page.
src/renderer    The React app, and the floating quick window.
src/addin       The Office add-in.
src/extension   The browser extension.
tests           Unit tests.
scripts         The end-to-end test and build helpers.
```

One engine serves every surface. It needs no server, so the add-in and the extension are static files.

## License

[MIT](LICENSE)
