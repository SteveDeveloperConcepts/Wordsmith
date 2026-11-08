# Underlines as you type in desktop Outlook and Word: spike

On 8 November 2026 a spike tested whether Wordsmith can draw its own underlines over the text in
classic Outlook and Word on Windows, with nothing installed in Office. It can. In real Outlook,
the underlines sit under the right words, follow typing and scrolling, open the same card as the
browser extension, and a fix lands in the draft. In real Word, the underlines and the card work
too. Fixes, typing, and scrolling were not tried in Word.

The cost is the open question. While the writer types, the prototype makes Outlook work about
twice as hard as it does alone. Outlook announces every keystroke and scroll through accessibility
events, so the full build can listen instead of asking, and should cost far less.

The prototype is off by default and is not in any release.

## How it works

1. Wordsmith already watches which window is in front, for Check Anywhere. When it is classic
   Outlook or Word, a small helper program (`live-helper.exe`) finds the message body or page through
   Windows' accessibility interface, UI Automation. Both apps draw their text with Word's text
   canvas, so one approach serves both.
2. The helper reads the text and its position on screen. Wordsmith checks the text with its usual
   engine, on the computer.
3. A transparent window is laid exactly over the text, and draws an underline under each flagged
   word, at the position the helper measured.
4. The window lets every click through to Outlook, except where the pointer rests on an underline
   or the card, so typing and selecting work as normal.
5. A fix selects the flagged words through the helper and pastes the correction over them, the
   way Check Anywhere replaces a selection. It checks the selection first and pastes nothing if the
   text has changed.

## What works

Tested in real classic Outlook (Microsoft 365, version 16.0.19127) with a 41-line draft and about
47 flagged words, using `scripts/live-outlook-check.ps1`:

- **Underlines** appear over the message body and line up with the words, including one that wraps
  across two lines.
- **The card** opens when the pointer rests on an underline, with the fixes, Dismiss, and Add to
  dictionary.
- **A fix** lands in the draft. The rest of the draft, its font, and the clipboard stay as they were,
  and Outlook keeps the keyboard.
- **Typing** keeps underlines in later paragraphs in place. The rest of the edited paragraph hides
  while the writer types and returns, with any new mistakes, about half a second after they pause.
- **Scrolling** brings the underlines back into line within 0.8 seconds.
- **Word** shows the underlines and the card over a document in its dark theme.

## What it costs

All figures are shares of one processor core. Outlook's own use varied a lot between identical
runs, so single figures are rough.

**While typing** a 67-character sentence at about nine characters a second, over 10.5 seconds:

| Setup | Outlook |
| --- | --- |
| Without Wordsmith | 8% and 18% in two runs |
| A client only listening for accessibility events | 23% |
| First prototype, measuring every underline on each keystroke | 62% |
| Final prototype, measuring one underline per keystroke | 28% to 45% in three runs |

Wordsmith itself and the helper each used 2% to 3% while typing.

**While idle**, with the draft open and nothing changing, Outlook used 2.5% to 4% with the overlay
up, against about 1% to 2% without it. Wordsmith and the helper used 1% to 2% each.

**Each question the helper asks**, as a median on a 2,356-character draft:

| Question | Time |
| --- | --- |
| Read the text, the body's position, and whether it scrolled | 4 ms |
| Measure one underline | 11 ms |
| Measure the 32 underlines on screen | 127 ms |

Every underline measured costs about 4 ms, and the work happens inside Outlook. That is why
measuring them all on each keystroke was so expensive.

**How quickly it responds:**

- The first underlines appear 1 to 1.4 seconds after a draft comes to the front, while the engine
  starts. Later checks take 0.15 to 0.25 seconds.
- A new mistake is underlined about half a second after typing pauses.
- During a scroll the underlines lag behind the text, and are back in place within 0.8 seconds.

**Accessibility events:** the message body raised one text-changed event per keystroke and one
scroll event per wheel scroll. It raised no selection-changed events.

## Problems found and fixed in the spike

- The overlay stopped taking clicks while a card was opening, so a click on a fix went through to
  Outlook.
- Measuring walked from the top of the document for every underline. It now measures only what is
  on screen, walking forward.
- A redraw asked for during another one was dropped, so the last scroll position could be missed.
- Every underline after the caret vanished while typing. They now move with their words.
- A measurement taken while the writer typed could drop correct underlines. The helper now refuses
  offsets for text it has not seen, and says when the text changed during a measurement.
- Outlook stores pasted lines as soft line breaks, which were not split correctly.
- A style reset took the colour off the card's fix button.

## What the full build needs

1. **Listen for events instead of asking.** Outlook raises text-changed and scroll events, so the
   helper can read the text only when it changes, and do nothing while the writer reads.
2. **Cheaper scrolling.** Move every underline by one measured offset at once, then correct, instead
   of measuring each one again.
3. **Skip the quoted thread and signature,** as the Office add-in does. A long reply thread would
   multiply every cost above.
4. **Keep the overlay just above Outlook,** not above every window, so Outlook's own menus and other
   programs are never drawn over.
5. **Pass the mouse wheel through** while the pointer rests on an underline. The overlay takes it now.
6. **A benchmark that repeats its runs,** because Outlook's own use varies so much.
7. **Tests:** the helper against recorded documents, and the overlay page against a fake helper.

**Not covered by the spike:** new Outlook, which is a different program; Outlook on a Mac or Word
on a Mac; fixes, typing, and scrolling in Word; right-to-left text; and screens with different
scaling side by side.

## Trying it

Build from source on Windows and run `npm run dev`. In Settings, under Integrations, turn on
**Underline as you type** in the **Outlook and Word on this PC (experimental)** group. Then bring
classic Outlook or Word to the front.

- Set `WORDSMITH_LIVE_DEBUG=1` before starting Wordsmith to log what the overlay reads, measures, and
  draws.
- With Wordsmith running and the setting on, `scripts/live-outlook-check.ps1` repeats the checks
  above. It types into a throwaway draft that it discards, and stops if the draft leaves the front.

## Where the code is

| File | What it does |
| --- | --- |
| `src/main/live/helper/LiveHelper.cs` | The helper, built into `resources/live-helper.exe` by `scripts/build-live-helper.mjs` |
| `src/main/live/index.ts` | Follows the window in front, reads the text, places the overlay, applies fixes |
| `src/renderer/src/live/LiveApp.tsx` | The overlay: checks, underlines, and the card |
| `src/renderer/src/live/text.ts` | Blocks, edits, and the fingerprint the helper shares, with tests |
| `scripts/live-outlook-check.ps1` | The checks and measurements in this document |
| `scripts/live-spike/` | The events probe and the benchmark |
