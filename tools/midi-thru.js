// Forward a MIDI keyboard's input to the Lens card (USB device mode).
//   node tools/midi-thru.js [keyboard-name-substring]
// With no arg, picks the first input that isn't the Lens card itself.
// Forwards notes/CC/bend/clock; drops sysex so it never clashes with the CLI.
'use strict';
const midi = require('@julusian/midi');
const inp = new midi.Input();
const out = new midi.Output();

const find = (io, sub) => {
  for (let i = 0; i < io.getPortCount(); i++)
    if (io.getPortName(i).toLowerCase().includes(sub)) return i;
  return -1;
};

console.log('MIDI inputs:');
for (let i = 0; i < inp.getPortCount(); i++) console.log(`  ${i}: ${inp.getPortName(i)}`);
console.log('MIDI outputs:');
for (let i = 0; i < out.getPortCount(); i++) console.log(`  ${i}: ${out.getPortName(i)}`);

const card = find(out, 'lens');
if (card < 0) { console.error('\nLens card not found in MIDI outputs -- is it plugged in and flashed?'); process.exit(1); }

const wantKb = (process.argv[2] || '').toLowerCase();
let kb = wantKb ? find(inp, wantKb) : -1;
if (kb < 0) for (let i = 0; i < inp.getPortCount(); i++)
  if (!inp.getPortName(i).toLowerCase().includes('lens')) { kb = i; break; }
if (kb < 0) { console.error('\nNo keyboard MIDI input found.'); process.exit(1); }

out.openPort(card);
inp.openPort(kb);
inp.ignoreTypes(true, false, true);  // ignore sysex + active-sensing, keep timing/clock
console.log(`\nForwarding  "${inp.getPortName(kb)}"  ->  "${out.getPortName(card)}"   (Ctrl-C to stop)`);
inp.on('message', (_dt, msg) => out.sendMessage(msg));
process.stdin.resume();
