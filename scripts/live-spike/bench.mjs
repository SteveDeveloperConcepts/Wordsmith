// Spike benchmark: where the live overlay helper's time goes against an Outlook draft. Read-only.
// Run through scripts/live-outlook-check.ps1 -Bench, which opens the draft and passes its handle.
// Usage: node scripts/live-spike/bench.mjs <window handle of the compose window>
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [hwnd] = process.argv.slice(2);
const helper = spawn(fileURLToPath(new URL('../../resources/live-helper.exe', import.meta.url)), [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
const lines = createInterface({ input: helper.stdout });
let next = 1;
const waiting = new Map();
lines.on('line', (line) => {
  const reply = JSON.parse(line);
  waiting.get(reply.id)?.(reply);
  waiting.delete(reply.id);
});
const ask = (command) =>
  new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    helper.stdin.write(JSON.stringify({ id, ...command }) + '\n');
  });

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const fmt = (n) => n.toFixed(1).padStart(6);

const editor = await ask({ cmd: 'editor', hwnd: Number(hwnd) });
if (!editor.found) {
  console.log('no editor found', editor);
  process.exit(1);
}
const text = editor.text;
console.log(`text: ${text.length} characters`);

const polls = [];
for (let i = 0; i < 20; i++) polls.push(await ask({ cmd: 'poll' }));
const col = (pick) => median(polls.map(pick));
console.log('poll, median ms over 20:');
console.log(`  read all text        ${fmt(col((r) => r.describeTiming[0]))}`);
console.log(`  field rectangle      ${fmt(col((r) => r.describeTiming[1]))}`);
console.log(`  has keyboard focus   ${fmt(col((r) => r.describeTiming[2]))}`);
console.log(`  scroll probe         ${fmt(col((r) => r.timing[1]))}`);
console.log(`  whole poll           ${fmt(col((r) => r.ms))}`);

// Every "mispelled" in the draft, then just the first one, as the page would ask.
const ranges = [];
for (let at = text.indexOf('mispelled'); at >= 0; at = text.indexOf('mispelled', at + 1)) ranges.push([at, at + 9]);
for (const [label, set] of [
  [`${ranges.length} ranges`, ranges],
  ['1 range', ranges.slice(0, 1)],
]) {
  const runs = [];
  for (let i = 0; i < 10; i++) runs.push(await ask({ cmd: 'rects', ranges: set }));
  const t = (k) => median(runs.map((r) => r.timing[k]));
  const drawn = runs[0].rects.filter((e) => e.rects.length > 0).length;
  console.log(`rects for ${label} (${drawn} on screen), median ms over 10:`);
  console.log(`  read all text        ${fmt(t(0))}`);
  console.log(`  find visible part    ${fmt(t(1))}`);
  console.log(`  measure the ranges   ${fmt(t(2))}`);
  console.log(`  read text again      ${fmt(t(3))}`);
  console.log(`  whole call           ${fmt(median(runs.map((r) => r.ms)))}`);
}
helper.stdin.end();
