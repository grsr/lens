'use strict';
// DX7 .syx -> Loupe converter (Tier 1: topology + ratio tuning + approximated EG).
// Packed bank format: F0 43 0n 09 20 00 [32 * 128 bytes] checksum F7.

// --- algorithm routing. mods[op] = list of operators that modulate op (1-based).
//     fb = operator carrying the feedback loop. carriers = ops that reach output. ---
const ALGORITHMS = {
  1: { carriers:[1,3], edges:[[2,1],[4,3],[5,4],[6,5]], feedback:[6,6] },
  2: { carriers:[1,3], edges:[[2,1],[4,3],[5,4],[6,5]], feedback:[2,2] },
  3: { carriers:[1,4], edges:[[2,1],[3,2],[5,4],[6,5]], feedback:[6,6] },
  4: { carriers:[1,4], edges:[[2,1],[3,2],[5,4],[6,5]], feedback:[4,6] },
  5: { carriers:[1,3,5], edges:[[2,1],[4,3],[6,5]], feedback:[6,6] },
  6: { carriers:[1,3,5], edges:[[2,1],[4,3],[6,5]], feedback:[5,6] },
  7: { carriers:[1,3], edges:[[2,1],[4,3],[5,3],[6,5]], feedback:[6,6] },
  8: { carriers:[1,3], edges:[[2,1],[4,3],[5,3],[6,5]], feedback:[4,4] },
  9: { carriers:[1,3], edges:[[2,1],[4,3],[5,3],[6,5]], feedback:[2,2] },
  10: { carriers:[1,4], edges:[[2,1],[3,2],[5,4],[6,4]], feedback:[3,3] },
  11: { carriers:[1,4], edges:[[2,1],[3,2],[5,4],[6,4]], feedback:[6,6] },
  12: { carriers:[1,3], edges:[[2,1],[4,3],[5,3],[6,3]], feedback:[2,2] },
  13: { carriers:[1,3], edges:[[2,1],[4,3],[5,3],[6,3]], feedback:[6,6] },
  14: { carriers:[1,3], edges:[[2,1],[4,3],[5,4],[6,4]], feedback:[6,6] },
  15: { carriers:[1,3], edges:[[2,1],[4,3],[5,4],[6,4]], feedback:[2,2] },
  16: { carriers:[1], edges:[[2,1],[3,1],[5,1],[4,3],[6,5]], feedback:[6,6] },
  17: { carriers:[1], edges:[[2,1],[3,1],[5,1],[4,3],[6,5]], feedback:[2,2] },
  18: { carriers:[1], edges:[[2,1],[3,1],[4,1],[5,4],[6,5]], feedback:[3,3] },
  19: { carriers:[1,4,5], edges:[[2,1],[3,2],[6,4],[6,5]], feedback:[6,6] },
  20: { carriers:[1,2,4], edges:[[3,1],[3,2],[5,4],[6,4]], feedback:[3,3] },
  21: { carriers:[1,2,4,5], edges:[[3,1],[3,2],[6,4],[6,5]], feedback:[3,3] },
  22: { carriers:[1,3,4,5], edges:[[2,1],[6,3],[6,4],[6,5]], feedback:[6,6] },
  23: { carriers:[1,2,4,5], edges:[[3,2],[6,4],[6,5]], feedback:[6,6] },
  24: { carriers:[1,2,3,4,5], edges:[[6,3],[6,4],[6,5]], feedback:[6,6] },
  25: { carriers:[1,2,3,4,5], edges:[[6,4],[6,5]], feedback:[6,6] },
  26: { carriers:[1,2,4], edges:[[3,2],[5,4],[6,4]], feedback:[6,6] },
  27: { carriers:[1,2,4], edges:[[3,2],[5,4],[6,4]], feedback:[3,3] },
  28: { carriers:[1,3,6], edges:[[2,1],[4,3],[5,4]], feedback:[5,5] },
  29: { carriers:[1,2,3,5], edges:[[4,3],[6,5]], feedback:[6,6] },
  30: { carriers:[1,2,3,6], edges:[[4,3],[5,4]], feedback:[5,5] },
  31: { carriers:[1,2,3,4,5], edges:[[6,5]], feedback:[6,6] },
  32: { carriers:[1,2,3,4,5,6], edges:[], feedback:[6,6] },
};

function unpackOp(b, o) {            // 17 packed bytes at offset o
  return {
    r:[b[o],b[o+1],b[o+2],b[o+3]],
    l:[b[o+4],b[o+5],b[o+6],b[o+7]],
    outLevel: b[o+14],
    mode:     b[o+15] & 1,          // 0 ratio, 1 fixed
    coarse:  (b[o+15] >> 1) & 31,
    fine:     b[o+16],
    detune:  (b[o+12] >> 3) & 15,   // 7 = centre
  };
}
function parseVoice(b128) {
  const ops = [];                   // packed order is OP6..OP1; store as ops[0..5] = OP1..OP6
  for (let i = 0; i < 6; i++) ops[5-i] = unpackOp(b128, i*17);
  return {
    ops,
    algorithm: (b128[110] & 31) + 1,
    feedback:   b128[111] & 7,
    transpose:  b128[117],
    name: String.fromCharCode(...b128.slice(118,128)).replace(/[^\x20-\x7e]/g,' ').trim(),
  };
}
function parseBank(buf) {
  // tolerate raw 4096 body or full SysEx wrapper
  let body = buf;
  if (buf[0] === 0xF0) body = buf.slice(6, 6 + 4096);
  const voices = [];
  for (let v = 0; v < 32; v++) voices.push(parseVoice(body.slice(v*128, v*128+128)));
  return voices;
}

// --- parameter maps (Tier 1 approximations) ---
const ratioOf = op => {
  const base = op.coarse === 0 ? 0.5 : op.coarse;
  return base * (1 + op.fine/100);
};
// Operator gain, ported verbatim from Dexed/msfa (env.cc scaleoutlevel + advance,
// fm_core.cc:105 gain = Exp2(level - 14<<24)). The DX7 level 0..99 is a log2/dB code,
// not a linear fraction. gain == 1.0 is unity = a full modulator swings the carrier
// phase one whole cycle (~2pi index), which matches our pm_offset, so the same gain
// scales both a carrier's audio level and a modulator's FM index. Velocity and
// keyboard level scaling are omitted (render at full velocity, no key scale).
const LEVELLUT = [0,5,9,13,17,20,23,25,27,29,31,33,35,37,39,41,42,43,45,46];
const scaleOut = x => x >= 20 ? 28 + x : LEVELLUT[x < 0 ? 0 : (x > 19 ? 19 : x)];
function opGain(egL, outLevel) {
  const outlevel_ = Math.min(127, scaleOut(outLevel)) << 5;
  let act = ((scaleOut(egL) >> 1) << 6) + outlevel_ - 4256;
  if (act < 16) act = 16;
  return Math.pow(2, (act - 3584) / 256);          // 1.0 = unity (full index / full output)
}
// Our dxeg maps level code/99 -> amplitude (code 99 = full scale = unity gain), and
// the kernel field is a byte, so a >unity carrier (gain up to ~2) packs up to ~198.
const levelCode = (egL, outLevel) => Math.max(0, Math.min(255, Math.round(99 * opGain(egL, outLevel))));
// dxeg's level bytes carry the DX7 LOG-DOMAIN segment targets (msfa actuallevel),
// not a linear amplitude: byte = clamp(actuallevel>>4, 0, 255). The kernel runs the
// real DX7 envelope (log-domain climb, jumptarget floor) so the bright-attack ping
// emerges. outlevel folds into every segment exactly as in env.cc:advance.
function dxegLevel(egL, outLevel) {
  const outlevel_ = Math.min(127, scaleOut(outLevel)) << 5;
  let act = ((scaleOut(egL) >> 1) << 6) + outlevel_ - 4256;
  if (act < 16) act = 16;
  return Math.max(0, Math.min(255, act >> 4));
}

function pitchOffset(op){
  const oct = Math.log2(ratioOf(op));
  const semisF = 12*oct;
  const semi = Math.round(semisF);
  let cents = Math.round((semisF-semi)*100) + Math.round((op.detune-7)*2.7);
  return { semi, cents };
}

// Frequency cell, matching runtime dx7_parse_voice. Ratio ops store (semi+64); fixed-
// frequency ops store an absolute MIDI note biased by FM_FIXED_BIAS. Fixed note from
// msfa (dx7note.cc osc_freq fixed branch): logfreq = 557327*e in (1<<24)/octave units,
// midinote_to_logfreq(n) = 50857777 + n*1398101.
const FM_FIXED_BIAS = 2480;
function freqCell(op){
  if (op.mode) {
    const e  = (op.coarse & 3) * 100 + op.fine;
    const lf = 557327 * e - 50857777;
    // note in 1/12-semitone units (sub-semitone fixed-freq precision)
    const nf = lf >= 0 ? Math.round(lf * 12 / 1398101) : -Math.round(-lf * 12 / 1398101);
    return (nf + FM_FIXED_BIAS) & 0xFFF;
  }
  return (pitchOffset(op).semi + 64) & 0xFFF;
}

// Emit the voice as a composable fn: (def NAME (fn (:trig :pitch => :out) ...)).
function emitVoiceFn(voice, name){
  const alg = ALGORITHMS[voice.algorithm];
  if(!alg) throw new Error('algorithm '+voice.algorithm+' not in table yet');
  const fbTarget = alg.feedback ? alg.feedback[1] : null;  // self-feedback the FB_IN op
  const L=[];
  L.push('; DX7 voice "'+voice.name+'"  algorithm '+voice.algorithm+'  feedback '+voice.feedback);
  L.push('(def '+name+' (fn (:gate :pitch => :out)');
  const done=new Set();
  const emit = n => {
    if(done.has(n)) return;
    done.add(n);                                  // mark first: breaks the feedback self-cycle
    const mods=(alg.edges||[]).filter(e=>e[1]===n && e[0]!==n).map(e=>e[0]);
    mods.forEach(emit);
    const op=voice.ops[n-1];
    const {semi,cents}=pitchOffset(op);
    const note = semi===0 ? 'pitch' : '(add pitch '+semi+')';
    const centsArg = cents!==0 ? ' :cents '+cents : '';
    // Faithful DX7 EG: the operator's output level folds into its 4 EG levels, so a
    // modulator's brightness tracks its own envelope (the tine pings then fades).
    const Le=op.l.map(l=>dxegLevel(l, op.outLevel));
    const env='(dxeg :gate gate :r1 '+op.r[0]+' :r2 '+op.r[1]+' :r3 '+op.r[2]+' :r4 '+op.r[3]+
              ' :l1 '+Le[0]+' :l2 '+Le[1]+' :l3 '+Le[2]+' :l4 '+Le[3]+')';
    const pmParts = mods.map(m => 'op'+m);
    const pmSrc = pmParts.length>1 ? '(mix '+pmParts.join(' ')+')' : pmParts[0];
    const pm = pmParts.length ? ' :pm '+pmSrc : '';
    // The feedback operator self-feeds via op_sine's :fb (the DX7 compute_fb mechanism,
    // exact last-two-outputs averaged in one kernel). The fb amount tracks the op's own
    // envelope so brightness mellows as the note fades (msfa feeds back the gain-scaled
    // output). FBSCALE maps DX7 feedback level (0..7) onto our 0..VMAX fb depth.
    if (n === fbTarget && voice.feedback > 0) {
      const FBSCALE = Math.round(4095 * voice.feedback / 7);
      L.push('  (def op'+n+'env '+env+')');
      L.push('  (def op'+n+' (vca (sine :note '+note+centsArg+pm+
             ' :fb (vca op'+n+'env '+FBSCALE+')) op'+n+'env))');
    } else {
      const body='(vca (sine :note '+note+centsArg+pm+') '+env+')';
      L.push('  (def op'+n+' '+body+')');
    }
  };
  alg.carriers.forEach(emit);
  const sum = alg.carriers.length===1 ? 'op'+alg.carriers[0]
            : '(mix '+alg.carriers.map(c=>'op'+c).join(' ')+')';
  // Carriers reach gain ~2.0 (unity is full modulation index, which is loud as audio).
  // The DX7 sums carriers on a wide bus then attenuates at output; in our 12-bit audio
  // a master half-scale keeps a full carrier at full scale instead of clipping.
  L.push('  (<- out (vca '+sum+' 2047))))');
  return L.join('\n')+'\n';
}

// A small demo patch that plays the voice at a fixed pitch, gate held per note.
function emitDemo(name, note){
  return ['', '(patch', '  (def g (clock :bpm 30 :width 3200))',
          '  (<- (audio-out :1) ('+name+' :gate g :pitch '+note+'))',
          '  (<- (audio-out :2) ('+name+' :gate g :pitch '+note+')))', ''].join('\n');
}

/* Voice as 56 twelve-bit cells (cell layout consumed by op_dx via pack12_read).
   cell[0]=algo, cell[1]=fbscale; op k at base 2+9k:
   [0]=semi+64, [1..4]=r[0..3], [5..8]=dxeg levels. */
function voiceCells(voice) {
  const cells = new Array(56).fill(0);
  cells[0] = (voice.algorithm - 1) & 31;
  cells[1] = voice.feedback > 0 ? Math.round(4095 * voice.feedback / 7) : 0;
  for (let i = 0; i < 6; i++) {
    const op = voice.ops[i];
    const base = 2 + 9 * i;
    cells[base + 0] = freqCell(op);
    cells[base + 1] = op.r[0] & 0xFF;
    cells[base + 2] = op.r[1] & 0xFF;
    cells[base + 3] = op.r[2] & 0xFF;
    cells[base + 4] = op.r[3] & 0xFF;
    cells[base + 5] = dxegLevel(op.l[0], op.outLevel) & 0xFF;
    cells[base + 6] = dxegLevel(op.l[1], op.outLevel) & 0xFF;
    cells[base + 7] = dxegLevel(op.l[2], op.outLevel) & 0xFF;
    cells[base + 8] = dxegLevel(op.l[3], op.outLevel) & 0xFF;
  }
  return cells;
}

/* Pack a voice into the 84-byte blob consumed by op_dx (56 cells, pack12 encoding). */
function voiceBlob(voice) {
  const cells = voiceCells(voice);
  const nPairs = 28;  /* 56 / 2 */
  const out = new Uint8Array(nPairs * 3);
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i] & 0xFFF;
    const pair = i >> 1;
    const base = pair * 3;
    if ((i & 1) === 0) {
      out[base]     = v & 0xFF;
      out[base + 1] = (out[base + 1] & 0xF0) | ((v >> 8) & 0x0F);
    } else {
      out[base + 1] = (out[base + 1] & 0x0F) | ((v & 0x0F) << 4);
      out[base + 2] = (v >> 4) & 0xFF;
    }
  }
  return out;
}

/* Emit a fused tape form: (def NAME (tape '(<56 ints>))). */
function emitFusedTape(voice, name) {
  const cells = voiceCells(voice);
  return `(def ${name} (tape '(${cells.join(' ')})))\n`;
}

module.exports = { parseBank, parseVoice, emitVoiceFn, emitDemo, voiceBlob, voiceCells,
                   ALGORITHMS, ratioOf, opGain, levelCode };

// --- CLI: node tools/dx7import.js <bank.syx> <voiceIndex> [--composed] > out.loupe
//     Default emits the fused tape voice + one fm patch. --composed emits the
//     hand-wired (sine+dxeg) voice fn + its patch instead (one patch either way). ---
if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);
  const composed = args.includes('--composed');
  const [file, idx='0'] = args.filter(a => a !== '--composed');
  const voices = parseBank(fs.readFileSync(file));
  const v = voices[+idx];
  process.stderr.write(`voice ${idx}: "${v.name}" algorithm ${v.algorithm} feedback ${v.feedback}\n`);
  if (composed) {
    process.stdout.write(emitVoiceFn(v, 'dxvoice'));
    process.stdout.write(emitDemo('dxvoice', 48));
  } else {
    process.stdout.write(emitFusedTape(v, 'dxvoice'));
    process.stdout.write(emitDemo('dxvoice', 48).replace(/\(dxvoice /g, '(dx :voice dxvoice '));
  }
}
