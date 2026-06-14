// nodes.js: node vocabulary. NODES order is the save format (NodeKind numbering); append-only.
'use strict';

const VMAX = 4095;

const EVERY_SAMPLE = 1;
const EVERY_BEAT   = 12000;
const EVERY_CTRL   = 4096;
const NEVER = Infinity;

const NODES = [
  ['none',        null,         null, 'empty slot'],
  ['lookup',      EVERY_BEAT,   null, '(lookup tape ix) tape[ix mod len]: the shared selection core; reads CURRENT bytes, so a mutable scale hunts. step/seek are heads over it'],
  ['turns',       EVERY_BEAT,   null, "(turns [c]) clock c's running turn count on the value ring; (mod (turns) 4) = bar position"],
  ['const',       NEVER,        null, 'a bare number: the constant stream (a literal operand for any two-stream op)'],
  ['wave',        EVERY_SAMPLE, 's',  '(wave tape [pitch|:note N]) play a region as audio: wavetable osc / sample playback; :reverse :pos :once :slots/:pick :scan :interp'],
  ['arrange',     EVERY_BEAT,   null, '(arrange prog...) data-driven tape combiner: the order is DATA (huntable); :len slices, :advancing interweaves'],
  ['counter',     EVERY_BEAT,   null, '(counter bar [:clock c]) bar number, +1 per clock tick (self-gating: catches up, never skips)'],
  ['random',      null,         null, '(random [:shape s] [:clock c]) shaped random value, re-rolled per tick (seeded, reproducible)'],
  ['chance',      null,         null, '(chance p [:clock c]) 0/VMAX with probability p/VMAX, re-rolled per tick'],
  ['walk',        null,         null, '(walk [:step N] [:clock c]) drunken walk around centre'],
  ['knob',        EVERY_CTRL,   null, '(knob :name) a panel knob as a value'],
  ['active-page', EVERY_CTRL,   null, '(active-page) the current page index'],
  ['cv-in',       EVERY_SAMPLE, null, '(cv-in N [:normal x]) CV input as a value'],
  ['pulse-in',    EVERY_SAMPLE, null, '(pulse-in N) pulse input as 0/VMAX'],
  ['audio-in',    EVERY_SAMPLE, 's',  '(audio-in N) audio input, audio-rate signal'],
  ['frozen',      EVERY_BEAT,   null, '(frozen tape-N) VMAX if the tape is frozen, else 0'],
  ['connected',   EVERY_CTRL,   null, '(connected jack) VMAX if a cable is patched into that input jack'],
  ['transpose',   null,         null, '(transpose r N) add N, a literal or a STREAM (clamped); octave-correct on a note'],
  ['invert',      null,         null, '(invert r) VMAX - value'],
  ['add',         null,         null, '(add a b) a + b, wraps on the value ring (:sat clamps); carries the signal domain'],
  ['sub',         null,         null, '(sub a b) a - b, wraps on the value ring (:sat clamps); carries the signal domain'],
  ['mul',         null,         null, '(mul a N) a * N saturating (gain); :wrap folds; :bipolar = ATTENUVERTER (centre=off, left inverts); a signal operand makes it a vca'],
  ['div',         null,         null, '(div a N) a / N'],
  ['mod',         null,         null, '(mod a N) a % N -> 0..N-1 (any N; bar/meter position)'],
  ['spread',      null,         null, '(spread a N) (a * N) >> VBITS -> 0..N-1: spread a value across N buckets'],
  ['shift',       null,         null, "(shift r N) offset a head's read by N positions (read into history)"],
  ['xor',         null,         null, '(xor a b) bitwise; carries the signal domain (bit-mangled audio renders)'],
  ['and',         null,         null, '(and a b) bitwise; carries the signal domain'],
  ['or',          null,         null, '(or a b) bitwise; carries the signal domain'],
  ['mask',        null,         null, '(mask r M) AND with a literal mask (bit-crush); carries the signal domain'],
  ['bit',         null,         null, '(bit r N) extract bit N as 0/VMAX'],
  ['gt',          null,         null, '(gt a b) a > b -> VMAX/0'],
  ['gte',         null,         null, '(gte a b) a >= b -> VMAX/0'],
  ['lt',          null,         null, '(lt a b) a < b -> VMAX/0'],
  ['lte',         null,         null, '(lte a b) a <= b -> VMAX/0'],
  ['eq',          null,         null, '(eq a b) a == b -> VMAX/0'],
  ['ne',          null,         null, '(ne a b) a != b -> VMAX/0'],
  ['switch',      null,         null, '(switch sel r0 r1 ..) selector mod count picks a branch (splice = switch over a counter)'],
  ['v-oct',       null,         null, '(v-oct note) emit a note value (0..127) as 1V/oct'],
  ['cv',          null,         null, '(cv r [:bipolar]) value -> linear unquantised voltage'],
  ['gate',        null,         null, '(gate r trig|gate) threshold -> pulse (trig = floor width, gate = held)'],
  ['envelope',    EVERY_SAMPLE, 's',  '(envelope [:peak p] :trig|:gate src :decay d) decaying envelope; default trigger = the master beat'],
  ['slew',        EVERY_SAMPLE, 's',  '(slew x N | :rate s) type-preserving smoother, rate literal or STREAM (portamento on a pitch signal)'],
  ['average',     EVERY_SAMPLE, 's',  '(average sig cutoff) THE filter primitive: one-pole EMA; lpf/hpf/bpf/lpg are composition over it'],
  ['shape',       null,         's',  '(sine|triangle|saw|square X) a waveform over a phase: X = a note (fused phase) or a phasor; param = shape'],
  ['record',      null,         null, 'the tape write: <- a stream into a tape sink (with :clock); the runtime write head'],
  ['wavefold',    null,         's',  '(wavefold sig drive) anti-aliased (ADAA) triangle wavefolder'],
  ['phasor',      EVERY_SAMPLE, 's',  '(phasor :hz|:khz|:rate|:tempo|note) THE phase engine: a 32-bit ramp; clock_from = hard sync; every clock is one of these'],
  ['edge',        EVERY_SAMPLE, null, '(edge x) rising edge of x -> a VMAX pulse'],
  ['hold',        EVERY_SAMPLE, null, "(hold value trig) latch value on trig's rising edge (S&H; the audio->byte bridge)"],
  ['diff',        EVERY_SAMPLE, null, '(diff x) x minus its previous value: the differentiator (slope), dual of the phasor'],
  ['toggle',      EVERY_SAMPLE, null, '(toggle trig) T flip-flop: flips 0<->VMAX per rising edge (/2 divider)'],
  ['schmitt',     EVERY_SAMPLE, null, '(schmitt x lo hi) comparator with hysteresis (clean triggering off noisy signals)'],
  ['tap',         EVERY_SAMPLE, 's',  '(tap tape N [:span] [:interp]) read N samples BEHIND the write head: the delay read (chorus/flanger/echo)'],
  ['noise',       EVERY_SAMPLE, 's',  '(noise) audio-rate white noise (per-sample xorshift), bipolar'],
  ['crush',       EVERY_SAMPLE, null, '(crush x N) sample-RATE reducer (decimator); N is modulatable'],
  ['vcf',         EVERY_SAMPLE, 's',  '(vcf sig cutoff res) 2-pole resonant low-pass SVF; res up to self-oscillation'],
  ['follow',      EVERY_SAMPLE, 's',  '(follow base :mult|:div N | :rate c [:drift d]) a DERIVED phasor in the phase domain (exact ratios re-cohere; drift bends)'],
  ['vclock',      EVERY_SAMPLE, null, '(clock :times TAPE) variable-step clock: each step lasts a duration read from a time tape'],
  ['tick',        EVERY_SAMPLE, null, '(tick [c]) a one-sample VMAX pulse each time clock c completes a turn (the eurorack trigger)'],
  ['snap',        null,         null, '(snap note SCALE | :mask m) nearest note whose pitch-class is in the 12-bit MASK (bit k = class k); the mask is a value, so scales select/morph/hunt live'],
  ['switch-pos',  EVERY_CTRL,   null, '(switch-pos) the panel Z-switch: 0 down, 1 middle, 2 up (bare `switch-z`, ports :up/:middle/:down)'],
  ['kick',        EVERY_SAMPLE, 's',  '(kick [pitch] [:note N] [:decay d] [:drive g] [:sweep s] [:trig clk]) synthetic bass drum, the IDEA after Plaits (MIT, E. Gillet): pitch sweep + body decay + drive saturation, fixed-point & divide-free; all of pitch/decay/drive/sweep take a value or a stream'],
  ['snare',       EVERY_SAMPLE, 's',  '(snare [pitch] [:note N] [:decay d] [:snappy s] [:tone t] [:trig clk]) snare drum, the IDEA after Plaits/808 (MIT, E. Gillet): two body modes + high-passed noise, blended by snappy; all of pitch/decay/snappy/tone take a value or a stream'],
  ['hat',         EVERY_SAMPLE, 's',  '(hat [pitch] [:note N] [:decay d] [:tone t] [:trig clk]) hi-hat / metallic percussion, the IDEA after Plaits/808 (MIT, E. Gillet): six inharmonic squares (from three phases) high-passed, fast decay'],
];
const KIND_ORDER    = NODES.map(n => n[0]);
const KIND_ENUM     = new Map(KIND_ORDER.map((k, i) => [k, i]));
const SIGNAL_KINDS  = new Set(NODES.filter(n => n[2] === 's').map(n => n[0]));
const NODE_INTERVAL = new Map(NODES.filter(n => n[1] != null).map(n => [n[0], n[1]]));

// Must mirror expression.h / tape.h.
const KNODEPOOL         = 512;
const KMAXGRAPHLITERALS = 64;
const BUFFER_BYTES      = 131072;
const CONTROL_BYTES     = 1024;

module.exports = { VMAX, EVERY_SAMPLE, EVERY_BEAT, EVERY_CTRL, NEVER, NODES, KIND_ORDER, KIND_ENUM, SIGNAL_KINDS, NODE_INTERVAL,
                   KNODEPOOL, KMAXGRAPHLITERALS, BUFFER_BYTES, CONTROL_BYTES };
