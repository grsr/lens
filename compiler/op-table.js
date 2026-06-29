'use strict';
// op-table.js: single source of truth for op->kernel wiring.
// Each row: { kernel?, inputs:[{kw,default,aliases?}], param0?:[{kw,shift,width,default?}] }
// inputs in slot order (in0, in1, ...). param0 fields are STRUCTURAL numeric params only.

// special, not table-driven:
//   knob, cv-in, audio-in, pulse-in, switch   (hw leaf jacks; param0 = jack index)
//   midi-note, midi-gate, midi-cc, midi-trig,  (MIDI leaf ops; param0 = midi_scratch index)
//   midi-velocity, midi-bend, midi-pressure,
//   midi-clock, midi-playing                   (single-slot: synced beat phasor + transport gate)
//   phasor, sine, triangle, saw, square        (oscillators; rate-mode bits in param0)
//     sine param0: mode bits1..0, pm bit2, depth bit3, phase bit4, fb (self-feedback) bit5
//     sine inputs:  in0=phase/rate, in1=pm, in2=depth, in3=fb
//   wave                                       (wavetable + drumrack variant; composite lowering)
//   snap, quantise, range, cv, v-oct           (mode-word or static-mask param0 shapes)
//   detent                                     (variadic snap-points; param0 = point count)
//   tap                                        (cross-slot wiring to paired recordhead head)
//   pluck                                       (Karplus-Strong; in0=trig in1=pitch in2=damp, in3=private audio delay buffer)
//   recordhead_*                               (variant chosen by cable kwargs)
//   morph                                      (variadic crossfade; param0 = input count)
//   normal                                     (expander sugar: (if (connected jack) jack default))
//   connected                                  (jack-patched predicate; param0 = jack index)
//   mix (variadic, >2 args)                    (chains to op_mix2 tree in lowerer)
//   add, mul, or, and (variadic, >2 args)      (same chain treatment)
//   feedback, z1                               (one-sample delay forms)
//   thru                                       (buffer+index; in0 is a buffer ref)
//   step, lookup, seek, wave_drumrack          (in0 is a buffer ref)
//   onsets, gates, hits                        (in0 is a buffer ref)
//   degree, pitch                              (in0=val, in1=buffer ref)
//   op_terminal_write_*                        (output jacks / LEDs)

const OP_TABLE = {

  // ---- binary arithmetic -------------------------------------------------
  add:       { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  sub:       { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  mul:       { inputs: [{kw:'a',default:0}, {kw:'gain',default:0}] },
  div:       { inputs: [{kw:'a',default:0}, {kw:'n',default:1}] },
  mod:       { inputs: [{kw:'a',default:0}, {kw:'n',default:1}] },
  spread:    { inputs: [{kw:'in',default:0}, {kw:'n',default:1}] },
  gt:        { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  gte:       { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  lt:        { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  lte:       { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  eq:        { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  ne:        { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  not:       { inputs: [{kw:'x',default:0}] },
  max:       { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  min:       { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  abs:       { inputs: [{kw:'x',default:0}] },
  rect:      { inputs: [{kw:'x',default:0}] },
  exp2:      { inputs: [{kw:'in',default:0}] },
  log2:      { inputs: [{kw:'in',default:0}] },
  and:       { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  or:        { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  xor:       { inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },
  transpose: { inputs: [{kw:'in',default:0}, {kw:'by',default:0}] },
  invert:    { inputs: [{kw:'in',default:0}] },
  shift:     { inputs: [{kw:'in',default:0}, {kw:'by',default:0}] },
  mask:      { inputs: [{kw:'in',default:0}, {kw:'mask',default:4095}] },
  bit:       { inputs: [{kw:'in',default:0}, {kw:'n',default:0}] },

  // op_if: 3 inputs (in0=cond, in1=then, in2=else)
  if:        { inputs: [{kw:'cond',default:0}, {kw:'then',default:0}, {kw:'else',default:0}] },

  // op_window: 3 inputs (in0=a, in1=lo, in2=hi)
  window:    { inputs: [{kw:'a',default:0}, {kw:'lo',default:0}, {kw:'hi',default:4095}] },

  // op_vca, op_ring: scale_depth(in0, in1)
  vca:       { inputs: [{kw:'in',default:0}, {kw:'amp',default:4095}] },
  ring:      { inputs: [{kw:'in',default:0}, {kw:'amp',default:4095}] },

  // op_mix2: binary mix (average)
  mix2:      { kernel: 'op_mix2', inputs: [{kw:'a',default:0}, {kw:'b',default:0}] },

  // ---- edge detectors / signal state ------------------------------------
  // op_edge: in0=signal, param0=width (optional, 0=default kTickWidth)
  edge:      { inputs: [{kw:'in',default:0}],
               param0: [{kw:'width',shift:0,width:32,default:0}] },

  // trig: kernel override to op_fall (detects the phasor ramp's falling edge = downbeat)
  // in0=signal, param0=width
  trig:      { kernel: 'op_fall',
               inputs: [{kw:'trig',default:0}],
               param0: [{kw:'width',shift:0,width:32,default:0}] },

  // op_fall: same as trig but named directly
  fall:      { inputs: [{kw:'x',default:0}],
               param0: [{kw:'width',shift:0,width:32,default:0}] },

  // op_diff: in0=signal
  diff:      { inputs: [{kw:'in',default:0}] },

  // op_toggle: in0=signal
  toggle:    { inputs: [{kw:'in',default:0}] },

  // op_hold: in0=val, in1=gate
  hold:      { inputs: [{kw:'val',default:0}, {kw:'on',default:0}] },

  // op_pickup: in0=live (knob), in1=on (selected gate); param0 = near | init<<16
  pickup:    { inputs: [{kw:'value',default:0}, {kw:'on',default:0}],
               param0: [{kw:'near',shift:0,width:16,default:0}, {kw:'init',shift:16,width:12,default:0}] },

  // op_gate: in0=signal, param0=len (0=kTickWidth)
  gate:      { inputs: [{kw:'in',default:0}],
               param0: [{kw:'len',shift:0,width:32,default:0}] },

  // op_schmitt: in0=sig, in1=lo, in2=hi
  schmitt:   { inputs: [{kw:'in',default:0}, {kw:'lo',default:1952}, {kw:'hi',default:2144}] },

  // op_z1: in0=x (one-sample delay)
  z1:        { inputs: [{kw:'x',default:0}] },

  // ---- filters / audio shaping ------------------------------------------
  // one-pole: in0=signal, in1=coefficient
  lpf:       { inputs: [{kw:'in',default:0}, {kw:'cut',default:2048}] },
  hpf:       { inputs: [{kw:'in',default:0}, {kw:'cut',default:2048}] },
  average:   { inputs: [{kw:'in',default:0}, {kw:'cut',default:2048}] },
  slew:      { inputs: [{kw:'in',default:0}, {kw:'rate',default:2048}] },
  lpg:       { inputs: [{kw:'in',default:0}, {kw:'ctrl',default:2048}] },
  envfollow: { inputs: [{kw:'in',default:0}, {kw:'cut',default:2048}] },

  // op_vcf: in0=sig, in1=cut, in2=res, param0=port (0=lp 1=hp 2=bp 3=notch)
  vcf:       { inputs: [{kw:'in',default:0}, {kw:'cut',default:2048}, {kw:'res',default:2048}],
               param0: [{kw:'port',shift:0,width:2,default:0}] },
  // resonant 2-pole SVF, single output per form (op_svf kernel, fixed port, audio-clamped).
  lpf2:      { kernel:'op_svf', inputs: [{kw:'in',default:0}, {kw:'cut',default:2048}, {kw:'res',default:0}],
               param0: [{kw:'port',shift:0,width:2,default:0}] },
  hpf2:      { kernel:'op_svf', inputs: [{kw:'in',default:0}, {kw:'cut',default:2048}, {kw:'res',default:0}],
               param0: [{kw:'port',shift:0,width:2,default:1}] },
  bpf2:      { kernel:'op_svf', inputs: [{kw:'in',default:0}, {kw:'cut',default:2048}, {kw:'res',default:0}],
               param0: [{kw:'port',shift:0,width:2,default:2}] },

  // op_wavefold: in0=sig, in1=drive
  wavefold:  { inputs: [{kw:'in',default:0}, {kw:'drive',default:0}] },

  // op_crush: in0=sig, in1=rate (higher=less crushing)
  crush:     { inputs: [{kw:'in',default:0}, {kw:'rate',default:4095}] },

  // op_saturate: in0=sig, in1=drive, in2=bias (bipolar), in3=mix, in4=level
  saturate:  { inputs: [{kw:'in',default:0}, {kw:'drive',default:0}, {kw:'bias',default:0},
                        {kw:'mix',default:4095}, {kw:'level',default:4095}] },

  // op_shape: LUT waveshaper. in0=sig, in1=drive(0..VMAX, signal).
  // param0 bits0..2 = curve (0 soft, 1 hard, 2 asym, 3 over),
  // bit4 = 4x oversample (:oversample 1, off by default). Both structural.
  shape:     { inputs: [{kw:'in',default:0}, {kw:'drive',default:0}],
               param0: [{kw:'curve',shift:0,width:3,default:0},
                        {kw:'oversample',shift:4,width:1,default:0}] },

  // ---- clocked generators -----------------------------------------------
  // op_random: in0=clk  (C reads s->in0 as clk)
  random:    { inputs: [{kw:'trig',default:0}] },

  // op_chance: in0=p, in1=clk
  chance:    { inputs: [{kw:'p',default:2048}, {kw:'trig',default:0}] },

  // op_walk: in0=clk, param0=step (0 -> 128 in kernel)
  walk:      { inputs: [{kw:'trig',default:0}],
               param0: [{kw:'step',shift:0,width:32,default:128}] },

  // ---- clock / rhythm ---------------------------------------------------
  // op_every: in0=N, in1=clk, param0=width
  every:     { inputs: [{kw:'n',default:1}, {kw:'trig',default:0}],
               param0: [{kw:'width',shift:0,width:32,default:0}] },

  // op_euclid: in0=pulses, in1=steps, in2=clk, param0=width
  euclid:    { inputs: [{kw:'pulses',default:0}, {kw:'steps',default:1}, {kw:'trig',default:0}],
               param0: [{kw:'width',shift:0,width:32,default:0}] },

  // op_turns: in0=clk
  turns:     { inputs: [{kw:'trig',default:0}] },

  // op_counter: in0=bars, in1=clk
  counter:   { inputs: [{kw:'bars',default:1}, {kw:'trig',default:0}] },

  // ---- voice kernels ----------------------------------------------------
  // op_envelope: in0=trig, in1=decay, param0=peak (0=VMAX in kernel)
  envelope:  { inputs: [{kw:'trig',default:0}, {kw:'decay',default:2048}],
               param0: [{kw:'peak',shift:0,width:32,default:0}] },

  // op_adsr: in0=gate, in1=attack, in2=decay, in3=sustain, in4=release, param0=peak
  adsr:      { inputs: [{kw:'gate',default:0},{kw:'attack',default:512},{kw:'decay',default:1024},{kw:'sustain',default:4095},{kw:'release',default:1024}],
               param0: [{kw:'peak',shift:0,width:32,default:0}] },

  // op_dxeg: in0=gate, in1..in4=R1..R4 (0..99), param0 packs L1|L2<<8|L3<<16|L4<<24
  //   (each a log-domain segment-target byte 0..255, == DX7 actuallevel>>4)
  dxeg:      { inputs: [{kw:'gate',default:0},{kw:'r1',default:0},{kw:'r2',default:0},{kw:'r3',default:0},{kw:'r4',default:0}],
               param0: [{kw:'l1',shift:0,width:8,default:0},{kw:'l2',shift:8,width:8,default:0},{kw:'l3',shift:16,width:8,default:0},{kw:'l4',shift:24,width:8,default:0}] },

  // op_follow: in0=base_ramp, in1=drift, param0=mult(low16)|div(high16)
  follow:    { inputs: [{kw:'base',default:0}, {kw:'drift',default:0}],
               param0: [{kw:'mult',shift:0,width:16,default:1},{kw:'div',shift:16,width:16,default:1}] },

  // ---- drum voices (all 5 inputs, in position order) --------------------
  // op_kick: in0=trig, in1=note, in2=decay, in3=drive, in4=sweep
  kick:      { inputs: [
                 {kw:'trig',default:0,aliases:['on']},
                 {kw:'note',default:24,aliases:['midi']},
                 {kw:'decay',default:2048},
                 {kw:'drive',default:0},
                 {kw:'sweep',default:0},
               ] },

  // op_snare: in0=trig, in1=note, in2=decay, in3=snappy, in4=tone; param0=seed
  snare:     { inputs: [
                 {kw:'trig',default:0,aliases:['on']},
                 {kw:'note',default:45,aliases:['midi']},
                 {kw:'decay',default:2048},
                 {kw:'snappy',default:2048},
                 {kw:'tone',default:2048},
               ],
               param0: [{kw:'seed',shift:0,width:32,default:0}] },

  // op_hat: in0=trig, in1=note, in2=decay, in3=tone
  hat:       { inputs: [
                 {kw:'trig',default:0,aliases:['on']},
                 {kw:'note',default:81,aliases:['midi']},
                 {kw:'decay',default:1200},
                 {kw:'tone',default:2600},
               ] },

};

module.exports = { OP_TABLE };
