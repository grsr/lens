'use strict';

// Lowerer: expanded AST -> IR graph.
// General path: OP_TABLE. Special handlers only for ops that need composite lowering.

const { OP_TABLE } = require('./op-table.js');

// Hardware input jacks in C hw_scratch order (runtime.c runtime_update_hw_scratch).
// THE single definition of jack -> index; test-jack-index.js gates it against C.
const HW_JACKS = [
  'audio-in-1', 'audio-in-2', 'pulse-in-1', 'pulse-in-2',
  'cv-in-1', 'cv-in-2', 'knob-main', 'knob-x', 'knob-y', 'switch-z',
];
const JACK_INDEX = Object.fromEntries(HW_JACKS.map((j, i) => [j, i]));

// midi_scratch index layout (must match runtime/midi.c; see attic/specs/midi.md).
const MIDI_NOTE_BASE = 0;    // + channel (0=omni, 1..16)
const MIDI_GATE_BASE = 17;   // + channel
const MIDI_CC_BASE   = 34;   // + cc number (0..127), omni
const MIDI_HELD_BASE = 162;  // + note (0..127)
const MIDI_VEL_BASE   = 290;  // + channel (velocity of last note-on, 0..4095)
const MIDI_BEND_BASE  = 307;  // + channel (12-bit, centre 2048)
const MIDI_PRESS_BASE = 324;  // + channel (channel pressure / aftertouch, 0..4095)
const MIDI_CLOCK_BASE = 341;  // single slot: beat phasor synced to MIDI clock
const MIDI_PLAY_BASE  = 342;  // single slot: transport gate (0/4095)

// Terminal sink names -> kernel name suffix.
const TERMINAL_SINKS = new Set([
  'audio-out-1', 'audio-out-2',
  'cv-out-1', 'cv-out-2',
  'pulse-out-1', 'pulse-out-2',
  'led-0', 'led-1', 'led-2', 'led-3', 'led-4', 'led-5',
]);

// Map a frequency in Hz to the nearest rate_table code (RATE mode, mode 2).
// rate_table is log-spaced 0.05 Hz .. 20 kHz over 256 entries (see
// runtime/rate_table.h); the runtime indexes it with (code >> 4) & 0xFF, so
// the code is index << 4. Used to represent sub-1 Hz oscillator rates, which
// the integer HZ domain (mode 1) rounds to 0.
function hzToRateCode(hz) {
  const lo = 0.05, hi = 20000, n = 256;
  let best = 0, bestErr = Infinity;
  for (let b = 0; b < n; b++) {
    const freq = lo * Math.pow(hi / lo, b / (n - 1));
    const err = Math.abs(freq - hz);
    if (err < bestErr) { bestErr = err; best = b; }
  }
  return best << 4;
}

// Choose recordhead kernel based on cable kwargs.
function recordheadKernel(kwargs) {
  const perSample = 'per-sample' in kwargs;
  const hasWhen = 'when' in kwargs;
  const hasLen = 'len' in kwargs;
  if (perSample) return 'op_recordhead_per_sample';
  if (hasLen && hasWhen) return 'op_recordhead_len_capped_gated';
  if (hasLen) return 'op_recordhead_len_capped';
  if (hasWhen) return 'op_recordhead_gated';
  return 'op_recordhead_per_cell';
}

function opToKernel(op) {
  return 'op_' + op.replace(/-/g, '_');
}

function chooseKernel(op, kwargs) {
  if (op === 'wave' && 'slots' in kwargs) return 'op_wave_drumrack';
  if (op === 'wave') return 'op_wave';
  // trig = phasor ramp's falling edge = downbeat (op_fall).
  if (op === 'trig') return 'op_fall';
  return opToKernel(op);
}

function lower(expanded) {
  let nextSlotId = 0;
  let nextBufId = 0;

  const slots = [];
  const buffers = [];
  const terminals = [];
  let masterSlotId = null;   // slot of the master clock, for beat/bar swaps

  // Memoisation: AST node object (by identity) -> lowered Ref.
  const memo = new Map();

  // Buffer allocation: AST node object -> buffer entry.
  const bufMemo = new Map();

  function allocSlot(kernel, ins, params, meta) {
    const id = nextSlotId++;
    const slot = {
      id,
      kernel,
      in: ins,
      out: { slotId: id, field: 'value' },
      params: params || {},
      meta: meta || {},
    };
    slots.push(slot);
    return { kind: 'slot', id };
  }

  function allocBuffer(kind, length, seed, keep) {
    const id = nextBufId++;
    const entry = { id, kind, length };
    if (seed !== undefined) entry.seed = seed;
    if (keep) entry.keep = true;
    buffers.push(entry);
    return { kind: 'buffer', id };
  }

  function lowerNode(node) {
    if (!node) return { kind: 'const', value: 0 };

    if (node.t === 'num') return { kind: 'const', value: node.v };
    if (node.t === 'flag') return { kind: 'const', value: 4095 };
    if (node.t === 'kw') return { kind: 'const', value: 0 };

    if (memo.has(node)) return memo.get(node);

    const ref = lowerNodeInner(node);
    memo.set(node, ref);
    // Record the master clock's slot (tagged by the expander) for beat/bar swaps.
    if (node._isMaster && ref && ref.kind === 'slot') masterSlotId = ref.id;
    return ref;
  }

  function lowerNodeInner(node) {
    switch (node.t) {
      case 'call':    return lowerCall(node);
      case 'lens':    return lowerLens(node);
      case 'opthru':  return lowerOpThru(node);
      // An op-lens selected but never applied: its value is the picked index.
      case 'oplens-sel': {
        const results = node.cells.map((_, k) => ({ t: 'num', v: k }));
        return lowerOpThru({ results, at: node.at, clamp: node.clamp });
      }
      case 'tape':    return lowerTape(node);
      case 'audio':   return lowerAudio(node);
      case 'connected': return lowerConnected(node);
      case 'z1':      return lowerZ1(node);
      // feedback is a no-op pass-through.
      case 'feedback': return lowerNode(node.args && node.args[0] ? node.args[0] : { t: 'num', v: 0 });
      case 'morph':   return lowerMorph(node);
      case 'outputs': return lowerOutputsNode(node);
      // oplens used outside thru is not a runtime value; emit zero.
      case 'oplens':  return { kind: 'const', value: 0 };
      case 'ref':     return { kind: 'const', value: 0 }; // fallback; shouldn't be hit
      case 'sym':
        throw new Error(`unknown name: ${node.s}`);
      default:
        return { kind: 'const', value: 0 };
    }
  }


  // Valid labels per jack family (the uniform call-form surface).
  const JACK_LABELS = {
    'cv-in':    ['1', '2'],   'audio-in': ['1', '2'], 'pulse-in': ['1', '2'],
    'cv-out':   ['1', '2'],   'audio-out':['1', '2'], 'pulse-out':['1', '2'],
    'knob':     ['main', 'x', 'y'],
    'switch':   ['z'],
    'led':      ['0', '1', '2', '3', '4', '5'],
  };

  // Interpretation flags that are not jack labels.
  const INTERP_FLAGS = new Set(['bipolar', 'v-oct', 'detent']);

  function jackLabel(family, kwargs) {
    const valid = JACK_LABELS[family];
    const labelKeys = Object.keys(kwargs).filter(
      k => kwargs[k].t === 'flag' && !INTERP_FLAGS.has(k));
    const label = labelKeys.length ? labelKeys[0] : undefined;
    if (label === undefined || !valid.includes(label)) {
      const list = valid.map(l => `${family} :${l}`).join(' and ');
      throw new Error(`(${family} :${label ?? '?'}): no such jack; this module has ${list}`);
    }
    return label;
  }

  // General table-driven lowering. param0 built from numeric kwargs only.
  // Input priority: positional args[i], then named kwarg, then aliases, then default.
  // Positional wins over kwargs so expander-injected :trig defaults don't displace
  // explicit positional streams (e.g. (trig (follow ...)) keeps follow as in0).
  function lowerTableOp(name, row, args, kwargs) {
    let kernel = row.kernel ?? ('op_' + name.replace(/-/g, '_'));
    // :sat selects the saturating variant (clamps at the value rails, not wrap).
    if ((name === 'add' || name === 'sub') && kwargs.sat && kwargs.sat.t === 'flag') {
      kernel = 'op_' + name + '_sat';
    }
    const ins = row.inputs.map((spec, i) => {
      let val = args[i];
      if (val === undefined) val = kwargs[spec.kw];
      if (val === undefined && spec.aliases) {
        for (const a of spec.aliases) { if (kwargs[a] !== undefined) { val = kwargs[a]; break; } }
      }
      if (val === undefined) return { kind: 'const', value: spec.default ?? 0 };
      return lowerNode(val);
    });
    let p0 = 0;
    if (row.param0) {
      for (const f of row.param0) {
        const kwVal = kwargs[f.kw];
        const v = (kwVal && kwVal.t === 'num') ? kwVal.v : (f.default ?? 0);
        const mask = f.width === 32 ? 0xFFFFFFFF : (1 << f.width) - 1;
        p0 = (p0 | ((v & mask) << f.shift)) >>> 0;
      }
    }
    return allocSlot(kernel, ins, { param0: p0 });
  }

  function lowerCall(node) {
    const { op } = node;
    let { args, kwargs } = node;

    // `:in` is an alias for the first positional signal; normalise here so
    // per-op cases and the table handler both see it as args[0].
    if (kwargs.in && kwargs.in.t !== 'flag') {
      args = [kwargs.in, ...args];
      kwargs = { ...kwargs };
      delete kwargs.in;
    }

    // (len tape): a buffer's length is fixed at compile time, so fold it to a
    // constant. (The expander already folds len of a lens/quote; tapes and audio
    // buffers reach here, where their allocated length is known.)
    if (op === 'len' && args.length === 1) {
      const ref = lowerNode(args[0]);
      if (ref.kind === 'buffer') {
        const buf = buffers.find(b => b.id === ref.id);
        if (buf) return { kind: 'const', value: buf.length };
      }
    }

    // Reading an output jack in value position is a direction error.
    if (op === 'cv-out' || op === 'audio-out' || op === 'pulse-out' || op === 'led') {
      const label = jackLabel(op, kwargs);
      throw new Error(`${op} :${label} is an output, cannot read it`);
    }

    /* Encode hw jack index for leaf kernels into param0 so C runtime can route hw inputs. */
    if (op === 'knob') {
      const label = jackLabel('knob', kwargs);              // main / x / y
      const jackIdx = JACK_INDEX['knob-' + label];
      const knobRef = allocSlot('op_knob', [], { param0: jackIdx }, { state: [] });
      // A bare knob is continuous (like a raw voltage). :detent opts into snapping
      // the rails (0 / vmid / vmax) past ADC jitter; :detent 0 is the same as omitting it.
      const detentOn = 'detent' in kwargs && !(kwargs.detent.t === 'num' && kwargs.detent.v === 0);
      if (!detentOn) return knobRef;
      const vmin = { kind: 'const', value: 0 };
      const vmid = { kind: 'const', value: 2048 };
      const vmax = { kind: 'const', value: 4095 };
      return allocSlot('op_detent', [knobRef, vmin, vmid, vmax], { param0: 3 }, { state: [] });
    }
    if (op === 'cv-in' || op === 'audio-in' || op === 'pulse-in') {
      const label = jackLabel(op, kwargs);                  // 1 / 2
      const jackIdx = JACK_INDEX[`${op}-${label}`];
      const kernel = 'op_' + op.replace(/-/g, '_');
      const leafRef = allocSlot(kernel, [], { param0: jackIdx }, { state: [] });
      // cv-in :bipolar centres on 0 by subtracting vmid.
      if (op === 'cv-in' && 'bipolar' in kwargs) {
        return allocSlot('op_sub', [leafRef, { kind: 'const', value: 2048 }], {}, { state: [] });
      }
      return leafRef;
    }
    // (switch :z): hardware z-switch. op_switch returns raw 0/1/2; map that to
    // the three rails (vmin/vmid/vmax) by picking through a const lens, dogfooding
    // the data-lens op_thru with a dynamic index. `switch` is the panel input only;
    // value selection by index is `pick` (below).
    if (op === 'switch' && args.length === 0
        && Object.keys(kwargs).some(k => kwargs[k].t === 'flag' && k === 'z')) {
      jackLabel('switch', kwargs);                          // validates :z
      const posRef = allocSlot('op_switch', [], { param0: JACK_INDEX['switch-z'] }, { state: [] });
      const railsRef = allocBuffer('lens', 3, [0, 2048, 4095]);
      return allocSlot('op_thru', [railsRef, posRef], {}, { state: [] });
    }
    if (op === 'switch') {
      throw new Error('switch is the panel input ((switch :z)); to select a value use (thru (lens a b ...) idx) or (if cond a b)');
    }

    // MIDI leaf ops: each reads midi_scratch[param0] via op_midi.
    // (midi-gate :note K): per-note gate, high while note K is held (any channel).
    // The HELD level is already 0/4095, so this is a bare leaf; pairs with midi-trig.
    if (op === 'midi-gate' && kwargs.note) {
      const noteNode = kwargs.note;
      if (noteNode.t !== 'num') throw new Error('(midi-gate :note N): :note must be a number 0..127');
      const note = noteNode.v;
      if (note < 0 || note > 127) throw new Error(`(midi-gate :note ${note}): note must be 0..127`);
      return allocSlot('op_midi', [], { param0: MIDI_HELD_BASE + note }, { state: [] });
    }
    // Per-channel MIDI leaves: note / gate / velocity / bend. param0 = base + channel
    // (0 = omni / no :ch, 1..16 = that channel).
    // Single-slot MIDI leaves (no channel): clock phasor + transport gate.
    if (op === 'midi-clock')   return allocSlot('op_midi', [], { param0: MIDI_CLOCK_BASE }, { state: [] });
    if (op === 'midi-playing') return allocSlot('op_midi', [], { param0: MIDI_PLAY_BASE }, { state: [] });

    const MIDI_CH_BASE = {
      'midi-note': MIDI_NOTE_BASE, 'midi-gate': MIDI_GATE_BASE,
      'midi-velocity': MIDI_VEL_BASE, 'midi-bend': MIDI_BEND_BASE,
      'midi-pressure': MIDI_PRESS_BASE,
    };
    if (op in MIDI_CH_BASE) {
      const chNode = kwargs.ch;
      let ch = 0;
      if (chNode && chNode.t === 'num') {
        ch = chNode.v;
        if (ch < 1 || ch > 16) throw new Error(`(${op} :ch ${ch}): channel must be 1..16`);
      } else if (chNode) {
        throw new Error(`(${op} :ch): expected a number 1..16`);
      }
      return allocSlot('op_midi', [], { param0: MIDI_CH_BASE[op] + ch }, { state: [] });
    }
    if (op === 'midi-cc') {
      // CC number given as a flag label, e.g. (midi-cc :1) -> kwargs key "1" with t==='flag'.
      const ccKey = Object.keys(kwargs).find(k => kwargs[k].t === 'flag' && /^\d+$/.test(k));
      if (ccKey === undefined) {
        throw new Error('(midi-cc): missing CC number label, e.g. (midi-cc :1)');
      }
      const K = parseInt(ccKey, 10);
      if (K < 0 || K > 127) throw new Error(`(midi-cc :${ccKey}): CC number must be 0..127`);
      return allocSlot('op_midi', [], { param0: MIDI_CC_BASE + K }, { state: [] });
    }
    if (op === 'midi-trig') {
      const noteNode = kwargs.note;
      if (!noteNode || noteNode.t !== 'num') {
        throw new Error('(midi-trig :note N): :note is required and must be a number 0..127');
      }
      const note = noteNode.v;
      if (note < 0 || note > 127) throw new Error(`(midi-trig :note ${note}): note must be 0..127`);
      const leafRef = allocSlot('op_midi', [], { param0: MIDI_HELD_BASE + note }, { state: [] });
      const edgeRef = allocSlot('op_edge', [leafRef], { param0: 0 });
      return allocSlot('op_gate', [edgeRef], { param0: 0 });
    }
    // wavetable / wt: flash-resident wavetable oscillator.
    // in0=pitch (NOTE domain), in1=pos (0..VMAX), in2=pm, param0 = (table_idx<<2)|mode.
    if (op === 'wavetable' || op === 'wt') {
      const RATE_KWARGS = ['note', 'midi', 'pitch', 'hz', 'rate', 'cents'];
      let mode = 0;
      let rateRef = { kind: 'const', value: 69 };
      for (const kw of RATE_KWARGS) {
        if (kwargs[kw]) {
          if (kw === 'hz') { mode = 1; } else if (kw === 'rate' || kw === 'cents') { mode = 2; }
          rateRef = lowerNode(kwargs[kw]);
          break;
        }
      }
      if (args[0]) rateRef = lowerNode(args[0]);
      const posRef = kwargs.pos  ? lowerNode(kwargs.pos)  : { kind: 'const', value: 0 };
      const pmRef  = kwargs.pm   ? lowerNode(kwargs.pm)   : { kind: 'const', value: 0 };
      const tableNode = kwargs.table;
      const tableIdx = (tableNode && tableNode.t === 'num') ? (tableNode.v & 3) : 0;
      const param0 = (mode & 3) | (tableIdx << 2);
      return allocSlot('op_wavetable', [rateRef, posRef, pmRef], { param0 });
    }
    // detent: in[0] = x, in[1..] = snap points; param0 = point count.
    if (op === 'detent') {
      const ins = args.map(lowerNode);
      const npts = ins.length > 0 ? ins.length - 1 : 0;
      return allocSlot('op_detent', ins.slice(0, 5), { param0: npts }, { state: [] });
    }
    // snap: fold a static scale into a 12-bit pitch-class mask in param0.
    if (op === 'snap') {
      const noteRef = args[0] ? lowerNode(args[0]) : { kind: 'const', value: 0 };
      const scaleNode = kwargs.scale !== undefined ? kwargs.scale : args[1];
      let mask = 0;
      if (scaleNode && scaleNode.t === 'num') {
        mask = scaleNode.v & 0xFFF;
      } else if (scaleNode && Array.isArray(scaleNode.items)) {
        for (const item of scaleNode.items) {
          if (item.t === 'num') mask |= 1 << (((item.v % 12) + 12) % 12);
        }
      }
      if (mask) return allocSlot('op_snap', [noteRef], { param0: mask }, { state: [] });
      // mask 0 (dynamic or empty scale): fall through to generic path.
    }
    // (mix a b c ...): equal-weight average by default; :levels '(w0 w1 ...) for a
    // custom weighting. Both normalise to the weight sum and expand to a sum of
    // vca'd inputs (no kernel), so N inputs mix at 1/N each and the output stays
    // bounded. Two inputs without :levels fall through to op_mix2 (a 50/50 average).
    if (op === 'mix') {
      const hasLevels = kwargs.levels &&
        (kwargs.levels.t === 'quote' || kwargs.levels.t === 'list');
      if (hasLevels || args.length > 2) {
        const inputs = args.map(lowerNode);
        let ws;
        if (hasLevels) {
          ws = kwargs.levels.items.map(it => (it.t === 'num' ? it.v : 0));
          if (ws.length !== inputs.length) {
            throw new Error(`(mix ... :levels): ${ws.length} levels for ${inputs.length} inputs`);
          }
        } else {
          ws = inputs.map(() => 1);   // equal weights
        }
        const sum = ws.reduce((a, b) => a + b, 0) || 1;
        const scaled = inputs.map((ref, i) =>
          allocSlot('op_vca', [ref, { kind: 'const', value: Math.round(ws[i] * 4095 / sum) }], {}, {}));
        if (scaled.length === 1) return scaled[0];
        return allocSlot('op_add', scaled, {}, {}); // post-pass folds >2 into an add2 tree
      }
    }
    // Variadic ops that chain into binary pairs.
    if (op === 'add' || op === 'mul' || op === 'or' || op === 'and') {
      const positionalInputs = args.map(lowerNode);
      if (positionalInputs.length > 2) {
        return lowerVariadic(op, positionalInputs, kwargs);
      }
    }

    // Table-driven general path: covers all OP_TABLE ops not already handled above.
    if (OP_TABLE[op]) {
      return lowerTableOp(op, OP_TABLE[op], args, kwargs);
    }

    const kernel = chooseKernel(op, kwargs);
    const ins = args.map(lowerNode);

    // range: one structural mode word in param0.
    if (op === 'range') {
      const xRef = args[0] !== undefined ? lowerNode(args[0]) : { kind: 'const', value: 0 };
      let param0 = 0;
      const tv = kwargs['to-value'], ti = kwargs['to-index'];
      if (tv && tv.t === 'num')      param0 = ((tv.v & 0x3FFFFFFF) | 0x40000000) >>> 0;
      else if (ti && ti.t === 'num') param0 = (ti.v & 0x3FFFFFFF) >>> 0;
      return allocSlot('op_range', [xRef], { param0 }, {});
    }

    // tap: C reads in0=buf, in1=amount, in2=cur_head, param0 bit0 = :span flag.
    // in2 is a placeholder filled by the post-pass with the paired recordhead head.
    if (op === 'tap') {
      const bufRef    = args[0] !== undefined ? lowerNode(args[0]) : { kind: 'const', value: 0 };
      const amountArg = kwargs.amount !== undefined ? kwargs.amount : args[1];
      const amountRef = amountArg !== undefined ? lowerNode(amountArg) : { kind: 'const', value: 0 };
      const spanFlag  = (kwargs.span && kwargs.span.t === 'flag') ? 1 : 0;
      return allocSlot('op_tap', [bufRef, amountRef, { kind: 'const', value: 0 }], { param0: spanFlag }, {});
    }

    // pluck: Karplus-Strong plucked string. in0=trig, in1=pitch (MIDI), in2=damp,
    // in3=private audio delay line. The buffer must cover the longest period
    // (lowest pitch): 1536 cells ~ MIDI 24 (~32 Hz) at 48 kHz.
    if (op === 'pluck') {
      const trigArg  = args[0] !== undefined ? args[0] : kwargs.trig;
      const pitchArg = args[1] !== undefined ? args[1] : kwargs.pitch;
      const dampArg  = args[2] !== undefined ? args[2] : kwargs.damp;
      const trigRef  = trigArg  !== undefined ? lowerNode(trigArg)  : { kind: 'const', value: 0 };
      const pitchRef = pitchArg !== undefined ? lowerNode(pitchArg) : { kind: 'const', value: 60 };
      const dampRef  = dampArg  !== undefined ? lowerNode(dampArg)  : { kind: 'const', value: 2048 };
      const bufRef   = allocBuffer('audio', 1536);
      return allocSlot('op_pluck', [trigRef, pitchRef, dampRef, bufRef], { param0: 0 }, {});
    }

    // dx: fused DX7 voice from a flash bank. param0 = bank index;
    // in0=decay, in1=pitch, in2=gate, in3=preset, in4=tone.
    if (op === 'dx') {
      const bankArg   = kwargs.bank   !== undefined ? kwargs.bank   : undefined;
      const presetArg = kwargs.preset !== undefined ? kwargs.preset : undefined;
      const pitchArg  = kwargs.pitch  !== undefined ? kwargs.pitch  : undefined;
      const gateArg   = kwargs.gate   !== undefined ? kwargs.gate   : undefined;
      const z = { kind: 'const', value: 0 };
      const pitchRef  = pitchArg  !== undefined ? lowerNode(pitchArg)  : { kind: 'const', value: 69 };
      const gateRef   = gateArg   !== undefined ? lowerNode(gateArg)   : z;
      const presetRef = presetArg !== undefined ? lowerNode(presetArg) : z;
      const bankIdx   = (bankArg && bankArg.t === 'num') ? bankArg.v : 0;
      const decayArg  = kwargs.decay !== undefined ? kwargs.decay : undefined;
      const toneArg   = kwargs.tone  !== undefined ? kwargs.tone  : undefined;
      const decayRef  = decayArg !== undefined ? lowerNode(decayArg) : { kind: 'const', value: 2048 };
      const toneRef   = toneArg  !== undefined ? lowerNode(toneArg)  : { kind: 'const', value: 2048 };
      return allocSlot('op_dx', [decayRef, pitchRef, gateRef, presetRef, toneRef], { param0: bankIdx }, {});
    }

    // wave (wavetable / grain reader): composites a phasor + op_wave from pitch kwargs.
    if (op === 'wave' && !('slots' in kwargs)) {
      const bufRef = args[0] !== undefined ? lowerNode(args[0]) : { kind: 'const', value: 0 };
      const PITCH = { midi: 0, note: 0, hz: 1, rate: 2 };
      const pk = ['midi', 'note', 'hz', 'rate'].find(k => k in kwargs);
      let scanRef;
      if (pk) {
        const mode = PITCH[pk] & 3;
        const rateRef = lowerNode(kwargs[pk]);
        const onceRef = kwargs.once ? lowerNode(kwargs.once) : null;
        const base = mode | (onceRef ? 4 : 0);
        const pins = onceRef ? [rateRef, onceRef] : [rateRef];
        let phaseRef = allocSlot('op_phasor', pins, { param0: base }, {}); // :phase ramp
        if (kwargs.len) phaseRef = allocSlot('op_vca', [phaseRef, lowerNode(kwargs.len)], {}, {});
        if (kwargs.pos) phaseRef = allocSlot('op_add', [phaseRef, lowerNode(kwargs.pos)], {}, {});
        scanRef = phaseRef;
      } else {
        scanRef = kwargs.pos ? lowerNode(kwargs.pos) : { kind: 'const', value: 0 };
      }
      return allocSlot('op_wave', [bufRef, scanRef], {}, {});
    }

    // thru (data-lens decode): C reads in0=lens buffer, index from in1 (always).
    if (op === 'thru') {
      const lensRef = kwargs.lens ? lowerNode(kwargs.lens)
                    : (args[0] !== undefined ? lowerNode(args[0]) : { kind: 'const', value: 0 });
      const atArg = kwargs.at !== undefined ? kwargs.at : args[1];
      const atRef = (atArg !== undefined && atArg.t === 'num')
                  ? { kind: 'const', value: atArg.v & 0xFFF }
                  : (atArg !== undefined ? lowerNode(atArg) : { kind: 'const', value: 0 });
      return allocSlot('op_thru', [lensRef, atRef], {}, {});
    }

    // Oscillators + clock: detect rate kwargs and bake mode bits into param0 low 2 bits.
    // Rate modes: 0=NOTE, 1=HZ, 2=RATE, 3=TEMPO.  in0 carries the rate value.
    const OSC_OPS = new Set(['phasor', 'sine', 'triangle', 'saw', 'square']);
    if (OSC_OPS.has(op)) {
      /* :midi is the same as :note for rate-mode purposes (both NOTE-domain). */
      const RATE_KWARGS = ['note', 'midi', 'hz', 'rate', 'tempo', 'bpm'];
      const found = RATE_KWARGS.filter(k => k in kwargs);
      if (found.length > 1) throw new Error(`ambiguous rate kwargs: ${found.join(', ')}`);

      let mode = 0;      // default NOTE
      const oscPositional = args.map(lowerNode);
      let rateRef = (oscPositional.length >= 1)
        ? oscPositional[0]
        : { kind: 'const', value: 69 };

      if (found.length === 1) {
        const kw = found[0];
        const val = kwargs[kw];
        if (kw === 'note' || kw === 'midi') {
          mode = 0;
          rateRef = lowerNode(val);
        } else if (kw === 'hz') {
          if (val.t === 'num' && !(Number.isInteger(val.v) && val.v >= 1)) {
            mode = 2;
            rateRef = { kind: 'const', value: hzToRateCode(val.v) };
          } else {
            mode = 1;
            rateRef = lowerNode(val);
          }
        } else if (kw === 'rate') {
          mode = 2;
          rateRef = lowerNode(val);
        } else if (kw === 'tempo') {
          mode = 3;
          rateRef = lowerNode(val);
        } else if (kw === 'bpm') {
          if (val.t === 'num') {
            const hz = val.v / 60;
            if (Number.isInteger(hz) && hz >= 1) {
              mode = 1;
              rateRef = { kind: 'const', value: hz };
            } else {
              mode = 2;
              rateRef = { kind: 'const', value: hzToRateCode(hz) };
            }
          } else {
            mode = 1;
            const bpmRef = lowerNode(val);
            const sixtyRef = { kind: 'const', value: 60 };
            rateRef = allocSlot('op_div', [bpmRef, sixtyRef], {}, {});
          }
        }
      }

      // :phase drives the shaper from an external phase (e.g. a phasor ramp) instead of
      // the internal accumulator (param0 bit 4). The rate/pitch is then ignored.
      const phaseRef = kwargs.phase ? lowerNode(kwargs.phase) : null;

      if (op === 'sine') {
        // sine: param0 encodes mode (bits 1..0), PM present (bit 2), depth present (bit 3),
        // phase-driven (bit 4), self-feedback present (bit 5).
        // Inputs: in0 = phase/rate, in1 = pm, in2 = depth, in3 = fb. Optional inputs that
        // precede a present one are padded with a const 0 to keep slot order.
        const pmRef    = kwargs.pm    ? lowerNode(kwargs.pm)    : null;
        const depthRef = kwargs.depth ? lowerNode(kwargs.depth) : null;
        const fbRef    = kwargs.fb    ? lowerNode(kwargs.fb)    : null;
        let param0 = mode & 3;
        if (phaseRef) param0 |= 16;
        if (pmRef)    param0 |= 4;
        if (depthRef) param0 |= 8;
        if (fbRef)    param0 |= 32;
        const z = { kind: 'const', value: 0 };
        const sineIns = [phaseRef || rateRef];
        if (pmRef || depthRef || fbRef) sineIns.push(pmRef || z);     // in1
        if (depthRef || fbRef)          sineIns.push(depthRef || z);  // in2
        if (fbRef)                      sineIns.push(fbRef);          // in3
        return allocSlot(kernel, sineIns.slice(0, 5), { param0 }, {});
      }

      // phasor outputs its ramp (the phase). :sync locks to an external pulse.
      if (op === 'phasor') {
        const syncRef = kwargs.sync ? lowerNode(kwargs.sync) : null;
        const lock = syncRef && found.length === 0 && args.length === 0;
        const base = (mode & 3) | (syncRef ? 4 : 0) | (lock ? 8 : 0);
        const pIns = syncRef ? [rateRef, syncRef] : [rateRef];
        return allocSlot('op_phasor', pIns, { param0: base }, {});
      }

      // triangle/saw/square: param0 low 2 bits = mode; in0 = rate value. With :phase,
      // in0 is an external phase (bit 4 set) and the rate is ignored.
      return allocSlot(kernel, [phaseRef || rateRef], { param0: phaseRef ? 16 : (mode & 3) }, {});
    }

    // wavetable / wt: flash-resident wavetable oscillator.
    // in0=pitch/hz/rate, in1=pos (0..4095), in2=pm. param0 = mode|(table_idx<<2).
    if (op === 'wavetable' || op === 'wt') {
      const RATE_KWARGS = ['note', 'midi', 'pitch', 'hz', 'rate', 'cents'];
      let mode = 0;
      let rateRef = { kind: 'const', value: 69 };
      for (const kw of RATE_KWARGS) {
        if (kwargs[kw] !== undefined) {
          if (kw === 'hz') { mode = 1; }
          else if (kw === 'rate' || kw === 'cents') { mode = 2; }
          rateRef = lowerNode(kwargs[kw]);
          break;
        }
      }
      if (args[0] !== undefined) rateRef = lowerNode(args[0]);
      const posRef = kwargs.pos !== undefined ? lowerNode(kwargs.pos) : { kind: 'const', value: 0 };
      const pmRef  = kwargs.pm  !== undefined ? lowerNode(kwargs.pm)  : { kind: 'const', value: 0 };
      const tableNode = kwargs.table;
      const tableIdx = (tableNode && tableNode.t === 'num') ? (tableNode.v & 3) : 0;
      const param0 = (mode & 3) | (tableIdx << 2);
      return allocSlot('op_wavetable', [rateRef, posRef, pmRef], { param0 }, {});
    }

    // Generic fallback for ops not in OP_TABLE and not handled above.
    // Numeric kwargs fold into param0 (sorted by key); dynamic kwargs become extra inputs.
    const params = {};
    const extraIns = [];

    for (const [k, v] of Object.entries(kwargs)) {
      if (k === 'port') continue;
      if (v.t === 'flag') {
        // Flags go into meta.
      } else if (v.t === 'num') {
        params[k] = v.v;
      } else {
        extraIns.push({ key: k, ref: lowerNode(v) });
      }
    }

    // trig inputs lead so clock-consumers find their clock first.
    const orderedExtras = [
      ...extraIns.filter(e => e.key === 'trig'),
      ...extraIns.filter(e => e.key !== 'trig'),
    ];

    const allIns = [
      ...ins,
      ...orderedExtras.map(e => e.ref),
    ].slice(0, 5);

    const flags = Object.entries(kwargs)
      .filter(([, v]) => v.t === 'flag')
      .map(([k]) => k);

    const meta = {};
    if (flags.length) meta.flags = flags;

    return allocSlot(kernel, allIns, params, meta);
  }

  function lowerVariadic(op, inputRefs, kwargs) {
    // Chain into binary pairs left-to-right.
    // (mix a b c d) -> mix2(mix2(a,b), mix2(c,d))
    const kernel = opToKernel(op) + '2';
    let refs = inputRefs;
    while (refs.length > 2) {
      const next = [];
      for (let i = 0; i < refs.length; i += 2) {
        if (i + 1 < refs.length) {
          const pairParams = {};
          for (const [k, v] of Object.entries(kwargs)) {
            if (v.t === 'num') pairParams[k] = v.v;
          }
          const flags = Object.entries(kwargs).filter(([, v]) => v.t === 'flag').map(([k]) => k);
          const meta = flags.length ? { flags } : {};
          next.push(allocSlot(kernel, [refs[i], refs[i + 1]], pairParams, meta));
        } else {
          next.push(refs[i]); // odd one out passes through
        }
      }
      refs = next;
    }
    // Final pair.
    const pairParams = {};
    for (const [k, v] of Object.entries(kwargs)) {
      if (v.t === 'num') pairParams[k] = v.v;
    }
    const flags = Object.entries(kwargs).filter(([, v]) => v.t === 'flag').map(([k]) => k);
    const meta = flags.length ? { flags } : {};
    return allocSlot(kernel, refs.slice(0, 2), pairParams, meta);
  }

  function lowerLens(node) {
    if (bufMemo.has(node)) return bufMemo.get(node);
    const seed = node.items.map(item => {
      if (item.t === 'num') return item.v;
      return 0;
    });
    const ref = allocBuffer('lens', seed.length, seed);
    bufMemo.set(node, ref);
    return ref;
  }

  // Lower a {t:'opthru', results:[node0..nodeK-1], at:atNode, clamp:bool}.
  function lowerOpThru(node) {
    const { results, at } = node;
    const K = results.length;
    const cellRefs = results.map(r => lowerNode(r));
    const rawAtRef = lowerNode(at);

    if (K === 0) return { kind: 'const', value: 0 };
    if (K === 1) return cellRefs[0];

    let atRef;
    if (node.clamp) {
      atRef = rawAtRef;
    } else {
      // Floored modulo: ((rawAt % K) + K) % K
      const kRef  = { kind: 'const', value: K };
      const mod1  = allocSlot('op_mod', [rawAtRef, kRef], {}, { state: [] });
      const addK  = allocSlot('op_add', [mod1, kRef], {}, { state: [] });
      atRef       = allocSlot('op_mod', [addK, kRef], {}, { state: [] });
    }

    function pick(refs, lo, hi) {
      if (hi - lo === 1) return refs[lo];
      const mid = (lo + hi) >> 1;
      const midRef = { kind: 'const', value: mid };
      const condRef = allocSlot('op_lt', [atRef, midRef], {}, { state: [] });
      const leftRef  = pick(refs, lo, mid);
      const rightRef = pick(refs, mid, hi);
      return allocSlot('op_if', [condRef, leftRef, rightRef], {}, { state: [] });
    }

    return pick(cellRefs, 0, K);
  }

  function lowerTape(node) {
    if (bufMemo.has(node)) return bufMemo.get(node);
    if (node.blankLen) {
      // A blank tape is a recording / wavetable buffer, so it lives in the large
      // sample pool. (The small control pool is for short literal sequences; the
      // pool is an internal detail -- the user just writes a tape.)
      const ref = allocBuffer('audio', node.blankLen);
      bufMemo.set(node, ref);
      return ref;
    }
    const seed = node.items.map(item => {
      if (item.t === 'num') return item.v;
      // _ and ~ are score rest/hold markers; they lower to 0.
      if (item.t === 'sym' && (item.s === '_' || item.s === '~')) return 0;
      if (item.t === 'sym') throw new Error(`unknown name: ${item.s}`);
      return 0;
    });
    const ref = allocBuffer('tape', seed.length, seed, node.keep);
    bufMemo.set(node, ref);
    return ref;
  }

  function lowerAudio(node) {
    if (bufMemo.has(node)) return bufMemo.get(node);
    let seconds = 1;
    if (node.seconds && node.seconds.t === 'num') seconds = node.seconds.v;
    else if (node.length && node.length.t === 'num') seconds = node.length.v / 48000;
    const length = Math.round(seconds * 48000);
    const ref = allocBuffer('audio', length);
    bufMemo.set(node, ref);
    return ref;
  }

  // Resolve a jack expression (e.g. (pulse-in :1)) to its hw jack index.
  // The jack number rides in kwargs as a flag (:1 / :2), matching the leaf
  // lowering, so read it with jackLabel rather than from positional args.
  function jackIndexOf(j) {
    if (!j) return 0;
    if (j.t === 'call' && (j.op === 'cv-in' || j.op === 'audio-in' || j.op === 'pulse-in')) {
      return JACK_INDEX[`${j.op}-${jackLabel(j.op, j.kwargs || {})}`] ?? 0;
    }
    if (j.t === 'sym') return JACK_INDEX[j.s] ?? 0;
    return 0;
  }

  // (connected JACK): reads only the connection mask (param0 = jack index), no inputs.
  function lowerConnected(node) {
    return allocSlot('op_connected', [], { param0: jackIndexOf(node.jack) }, {});
  }

  function lowerZ1(node) {
    const inRef = lowerNode(node.x);
    return allocSlot('op_z1', [inRef], {}, { state: ['last'] });
  }

  function lowerMorph(node) {
    const ins = (node.args || []).map(lowerNode).slice(0, 5);
    // param0 = input count: op_morph crossfades across its ins, needs the count up front.
    return allocSlot('op_morph', ins, { param0: ins.length }, {});
  }

  function lowerOutputsNode(node) {
    if (node.ports && node.ports.length > 0) {
      return lowerNode(node.ports[0].value);
    }
    return { kind: 'const', value: 0 };
  }

  // Resolve an output-jack sink to its terminal jack name.
  function resolveJackSink(jack, labels) {
    const valid = JACK_LABELS[jack];
    const labelKeys = labels.filter(l => !INTERP_FLAGS.has(l));
    const label = labelKeys.length ? labelKeys[0] : undefined;
    if (label === undefined || !valid.includes(label)) {
      const list = valid.map(l => `${jack} :${l}`).join(' and ');
      throw new Error(`(${jack} :${label ?? '?'}): no such jack; this module has ${list}`);
    }
    return {
      jackName: `${jack}-${label}`,
      bipolar: labels.includes('bipolar'),
      vOct:    labels.includes('v-oct'),
    };
  }

  // Direction-typed input jacks cannot be written to.
  const INPUT_JACK_OPS = new Set(['cv-in', 'audio-in', 'pulse-in', 'knob']);

  function lowerCable(cable) {
    const { sink, value, kwargs } = cable;

    if (sink.t === 'call' && INPUT_JACK_OPS.has(sink.op)) {
      const label = jackLabel(sink.op, sink.kwargs);
      throw new Error(`${sink.op} :${label} is an input, cannot write to it`);
    }
    if (sink.t === 'call' && sink.op === 'switch') {
      throw new Error(`switch :z is an input, cannot write to it`);
    }

    // Scatter sink: fan a write across a jack family, to the selected member.
    // One case of the general finite demux (see scatterGuards).
    if (sink.t === 'jackscatter') {
      const family = JACK_LABELS[sink.jack];
      const valRef = lowerNode(value);
      const guards = scatterGuards(lowerNode(sink.selector), family.length);
      for (let i = 0; i < family.length; i++) {
        const jackName = `${sink.jack}-${family[i]}`;
        const normal = jackNormals.get(jackName);
        const elseRef = normal ? lowerNode(normal) : { kind: 'const', value: 0 };
        const drive = allocSlot('op_if', [guards[i], valRef, elseRef], {}, { state: [] });
        const kernel = 'op_terminal_write_' + jackName.replace(/-/g, '_');
        const slotRef = allocSlot(kernel, [drive], {}, { state: [], jack: jackName });
        terminals.push({ jack: jackName, slotId: slotRef.id });
      }
      return;
    }

    // Output jack sink: (<- (cv-out :1) X).
    if (sink.t === 'jacksink') {
      const { jackName, bipolar, vOct } = resolveJackSink(sink.jack, sink.labels);
      if (scatterFamilies.has(sink.jack)) return;
      let valRef = lowerNode(value);
      if (sink.jack === 'cv-out' && bipolar && !vOct) {
        valRef = allocSlot('op_cv', [valRef], { param0: 1 }, { state: [] });
      }
      const kernel = 'op_terminal_write_' + jackName.replace(/-/g, '_');
      const slotRef = allocSlot(kernel, [valRef], {}, { state: [], jack: jackName });
      const mode = (sink.jack === 'cv-out' && vOct) ? 1 : 0;
      terminals.push({ jack: jackName, slotId: slotRef.id, mode });
      return;
    }

    if (sink.t === 'sym' && TERMINAL_SINKS.has(sink.s)) {
      const valRef = lowerNode(value);
      const jackSuffix = sink.s.replace(/-/g, '_');
      const kernel = 'op_terminal_write_' + jackSuffix;
      const slotRef = allocSlot(kernel, [valRef], {}, { state: [], jack: sink.s });
      terminals.push({ jack: sink.s, slotId: slotRef.id });
      return;
    }

    // Tape-bank write: (<- (thru (lens TAPES...) SEL) VAL ...) fans the write to
    // the selected tape. A thru over a buffer lens expands to a buflens-sel (the
    // tapes + index), the same node the read side distributes over. This is the
    // finite demux (scatterGuards) over memory, so :when rejoins naturally.
    if (sink.t === 'buflens-sel') {
      emitBankWrite(sink, value, kwargs);
      return;
    }

    // Seek-write sink: (<- (seek TAPE IDX) VAL) writes VAL at index IDX (random access).
    if (sink.t === 'call' && sink.op === 'seek') {
      emitSeekWrite(sink, value, kwargs);
      return;
    }

    // MIDI output sinks: side-effecting roots, no terminal push.
    if (sink.t === 'call' && (sink.op === 'midi-note-out' || sink.op === 'midi-cc-out' || sink.op === 'midi-clock-out')) {
      emitMidiOut(sink, value, kwargs);
      return;
    }

    // Buffer sink (tape / audio / lens).
    emitRecordhead(sink, value, kwargs);
  }

  // Build a random-access write slot for a (seek TAPE IDX) cable sink.
  // in0=value, in1=buffer, in2=index, in3=clock, in4=gate (param0 bit0).
  function emitSeekWrite(sink, value, kwargs) {
    const tape = sink.args[0];
    const idxRef = lowerNode(sink.args[1]);
    const valRef = lowerCableValue(value, kwargs);
    const clk = kwargs.trig || (sink.kwargs && sink.kwargs.trig);
    const clkRef = clk ? lowerNode(clk) : { kind: 'const', value: 0 };
    const whenRef = kwargs.when ? lowerNode(kwargs.when) : null;

    // Seek-write into a bank: (<- (seek (thru TAPES SEL) IDX) VAL). Distribute over
    // the tapes, each gated by sel==i (and any :when), so exactly the selected tape
    // records at IDX. Same finite demux (scatterGuards) as the sequential bank write.
    if (tape.t === 'buflens-sel') {
      const tapeRefs = tape.cells.map(lowerNode);
      const guards = scatterGuards(lowerNode(tape.at), tapeRefs.length);
      for (let i = 0; i < tapeRefs.length; i++) {
        let gate = guards[i];
        if (whenRef) gate = allocSlot('op_if', [guards[i], whenRef, { kind: 'const', value: 0 }], {}, { state: [] });
        allocSlot('op_recordhead_seek', [valRef, tapeRefs[i], idxRef, clkRef, gate], { param0: 1 });
      }
      return;
    }

    // Single tape. Gate by :when if present (in4), else the plain ungated write.
    const bufRef = lowerNode(tape);
    if (whenRef) {
      allocSlot('op_recordhead_seek', [valRef, bufRef, idxRef, clkRef, whenRef], { param0: 1 });
    } else {
      const ins = [valRef, bufRef, idxRef];
      if (clk) ins.push(clkRef);
      allocSlot('op_recordhead_seek', ins, {});
    }
  }

  // MIDI output sink: emit a MIDI-out kernel slot (side-effecting root, no terminal push).
  function emitMidiOut(sink, value, kwargs) {
    const op = sink.op;
    const sinkKwargs = sink.kwargs || {};

    // Read :ch (channel 1..16 -> 0..15 internally).
    const chNode = sinkKwargs.ch || kwargs.ch;
    const ch = (chNode && chNode.t === 'num') ? ((chNode.v - 1) & 0x0F) : 0;

    if (op === 'midi-note-out') {
      const pitchRef = lowerNode(value);
      const gateNode = kwargs.gate;
      const velNode  = kwargs.vel;
      const gateRef  = gateNode ? lowerNode(gateNode) : { kind: 'const', value: 0 };
      const velRef   = velNode  ? lowerNode(velNode)  : { kind: 'const', value: 4095 };
      allocSlot('op_midi_note_out', [pitchRef, gateRef, velRef], { param0: ch });
    } else if (op === 'midi-cc-out') {
      const ccNode = sinkKwargs.cc || kwargs.cc;
      if (!ccNode || ccNode.t !== 'num') throw new Error('(midi-cc-out): :cc must be a number 0..127');
      const ccnum = ccNode.v & 0x7F;
      const valRef = lowerNode(value);
      allocSlot('op_midi_cc_out', [valRef], { param0: ch | (ccnum << 4) });
    } else if (op === 'midi-clock-out') {
      const tickRef = lowerNode(value);
      allocSlot('op_midi_clock_out', [tickRef], { param0: 0 });
    }
  }

  // Finite demux. Wrap a selector into [0,N) and return one guard per member,
  // (selector == i). The shared mechanism for any sink that fans a write across a
  // fixed set of places (a jack family, a tape bank): each place is driven/written
  // under its guard, so exactly one fires.
  function scatterGuards(selRef, N) {
    const kRef = { kind: 'const', value: N };
    const m1   = allocSlot('op_mod', [selRef, kRef], {}, { state: [] });
    const addK = allocSlot('op_add', [m1, kRef], {}, { state: [] });
    const wrap = allocSlot('op_mod', [addK, kRef], {}, { state: [] });
    const guards = [];
    for (let i = 0; i < N; i++) {
      guards.push(allocSlot('op_eq', [wrap, { kind: 'const', value: i }], {}, { state: [] }));
    }
    return guards;
  }

  // Dynamic record head: fan a write across a bank of tapes, recording into the
  // selected one. The addressing is scatterGuards (one guard per tape, sel==i);
  // the write into memory is a gated record head per tape, gated by its guard
  // and-ed with any :when. So exactly the selected tape records.
  function emitBankWrite(sink, value, kwargs) {
    const tapeRefs = sink.cells.map(lowerNode);
    const N = tapeRefs.length;
    const guards = scatterGuards(lowerNode(sink.at), N);
    const valRef = lowerCableValue(value, kwargs);
    const whenRef = kwargs.when ? lowerNode(kwargs.when) : null;
    const perSample = 'per-sample' in kwargs;
    const clkRef = kwargs.trig ? lowerNode(kwargs.trig) : null;
    if (!perSample && !clkRef) {
      throw new Error('a clocked tape-bank write needs :trig (or use :per-sample)');
    }
    const lenLit = (kwargs.len && kwargs.len.t === 'num') ? kwargs.len.v : null;
    for (let i = 0; i < N; i++) {
      // gate = this tape is selected, and-ed with the optional :when.
      let gate = guards[i];
      if (whenRef) gate = allocSlot('op_if', [guards[i], whenRef, { kind: 'const', value: 0 }], {}, { state: [] });
      if (perSample) {
        allocSlot('op_recordhead_per_sample', [valRef, tapeRefs[i], gate], { param0: 1 });
      } else if (lenLit != null) {
        allocSlot('op_recordhead_len_capped_gated', [valRef, tapeRefs[i], gate, clkRef], { param0: lenLit });
      } else {
        allocSlot('op_recordhead_gated', [valRef, tapeRefs[i], gate, clkRef], {});
      }
    }
  }

  // Build a recordhead slot for a buffer-sink cable.
  function emitRecordhead(sink, value, kwargs) {
    const bufRef = lowerNode(sink);
    const kernel = recordheadKernel(kwargs);
    const valRef = lowerCableValue(value, kwargs);
    const params = {};
    for (const [k, v] of Object.entries(kwargs)) {
      if (k === 'per-sample' || v.t === 'flag' || v.t !== 'num') continue;
      params[k] = v.v;
    }
    const dynLen = kwargs.len && kwargs.len.t !== 'num' && kwargs.len.t !== 'flag';
    if (kernel === 'op_recordhead_len_capped_gated' && dynLen) {
      throw new Error('recordhead :len with :when must be a constant cap, not a stream');
    }
    const extraIns = [];
    const pushDyn = ref => { if (ref && ref.t !== 'num' && ref.t !== 'flag') extraIns.push(lowerNode(ref)); };
    pushDyn(kwargs.when);
    pushDyn(kwargs.len);
    if (kwargs.trig) extraIns.push(lowerNode(kwargs.trig));
    if (kernel === 'op_recordhead_per_sample' && 'when' in kwargs) {
      params.param0 = (params.param0 || 0) | 1;
    }
    if (extraIns.length > 2) {
      throw new Error(`recordhead has too many dynamic inputs (${2 + extraIns.length} > 5 slots)`);
    }
    const allIns = [valRef, bufRef, ...extraIns].slice(0, 5);
    allocSlot(kernel, allIns, params);
  }

  function lowerCableValue(value, kwargs) {
    return lowerNode(value);
  }

  // Scatter fall-through pre-scan.
  const scatterFamilies = new Set();
  for (const c of expanded.cables) {
    if (c.sink && c.sink.t === 'jackscatter') scatterFamilies.add(c.sink.jack);
  }
  const jackNormals = new Map(); // jackName -> value node
  for (const c of expanded.cables) {
    if (c.sink && c.sink.t === 'jacksink' && scatterFamilies.has(c.sink.jack)) {
      const { jackName } = resolveJackSink(c.sink.jack, c.sink.labels);
      jackNormals.set(jackName, c.value);
    }
  }

  // Lower all cables.
  for (const cable of expanded.cables) {
    lowerCable(cable);
  }

  // Post-pass: wire op_tap.in[2] to the paired recordhead's head_pos_out.
  {
    const RECORDHEAD_KERNELS = new Set([
      'op_recordhead_per_sample', 'op_recordhead_per_cell',
      'op_recordhead_gated', 'op_recordhead_len_capped', 'op_recordhead_len_capped_gated',
      'op_recordhead_seek',
    ]);
    const bufToRecHead = new Map();
    for (const slot of slots) {
      if (!RECORDHEAD_KERNELS.has(slot.kernel)) continue;
      const bufIn = slot.in[1];
      if (bufIn && bufIn.kind === 'buffer') bufToRecHead.set(bufIn.id, slot.id);
    }
    for (const slot of slots) {
      if (slot.kernel !== 'op_tap') continue;
      const bufIn = slot.in[0];
      if (!bufIn || bufIn.kind !== 'buffer') continue;
      const recHeadId = bufToRecHead.get(bufIn.id);
      if (recHeadId == null) continue;
      slot.in[2] = { kind: 'slot', id: recHeadId, read: 'head' };
    }
  }

  // Post-pass: fold N-ary inputs on strictly binary kernels into a binary tree.
  const BINARY_KERNELS = new Set(['op_add2', 'op_mul2', 'op_mix2', 'op_and2', 'op_or2']);
  const NEEDS_BINARY = new Set([...BINARY_KERNELS, 'op_add', 'op_mul', 'op_and', 'op_or']);
  for (const slot of slots.slice()) {
    if (!NEEDS_BINARY.has(slot.kernel)) continue;
    if (slot.in.length <= 2) continue;
    let refs = slot.in.slice();
    const kernel = BINARY_KERNELS.has(slot.kernel) ? slot.kernel : slot.kernel + '2';
    while (refs.length > 2) {
      const next = [];
      for (let i = 0; i < refs.length; i += 2) {
        if (i + 1 < refs.length) {
          next.push(allocSlot(kernel, [refs[i], refs[i + 1]], slot.params, {}));
        } else {
          next.push(refs[i]);
        }
      }
      refs = next;
    }
    slot.in = refs.slice(0, 2);
    slot.kernel = kernel;
  }

  return { buffers, slots, terminals, masterSlotId };
}

// Sanity check: assert structural invariants on a lowered graph.
function verify(graph) {
  const errors = [];
  const slotIds = new Set(graph.slots.map(s => s.id));
  const bufIds = new Set(graph.buffers.map(b => b.id));

  function checkRef(ref, ctx) {
    if (!ref) { errors.push(`${ctx}: null ref`); return; }
    if (ref.kind === 'slot' && !slotIds.has(ref.id)) {
      errors.push(`${ctx}: dangling slot ref ${ref.id}`);
    }
    if (ref.kind === 'buffer' && !bufIds.has(ref.id)) {
      errors.push(`${ctx}: dangling buffer ref ${ref.id}`);
    }
  }

  const seenSlotIds = new Set();
  for (const slot of graph.slots) {
    if (seenSlotIds.has(slot.id)) {
      errors.push(`duplicate slot id ${slot.id}`);
    }
    seenSlotIds.add(slot.id);
    for (let i = 0; i < slot.in.length; i++) {
      checkRef(slot.in[i], `slot[${slot.id}].in[${i}]`);
    }
  }

  for (const term of graph.terminals) {
    if (!slotIds.has(term.slotId)) {
      errors.push(`terminal ${term.jack}: dangling slot ref ${term.slotId}`);
    }
  }

  /* Structural invariants */

  // 1. Every hw-leaf kernel must carry param0 in 0..9 (jack index).
  const HW_LEAVES = new Set(['op_knob', 'op_cv_in', 'op_audio_in', 'op_pulse_in', 'op_switch']);
  for (const slot of graph.slots) {
    if (HW_LEAVES.has(slot.kernel)) {
      const p0 = slot.params?.param0;
      if (typeof p0 !== 'number' || p0 < 0 || p0 > 9) {
        errors.push(`slot[${slot.id}] ${slot.kernel}: param0 must be a valid jack index 0..9, got ${p0}`);
      }
    }
  }

  // 2. Oscillator kernels must have in[0] routed.
  const OSCILLATORS = new Set(['op_phasor', 'op_sine', 'op_triangle', 'op_saw', 'op_square']);
  for (const slot of graph.slots) {
    if (OSCILLATORS.has(slot.kernel)) {
      if (!slot.in || slot.in.length === 0 || slot.in[0] == null) {
        errors.push(`slot[${slot.id}] ${slot.kernel}: in[0] missing (oscillator must route a rate input)`);
      }
    }
  }

  // 3. No leading-underscore param keys (internal-only markers).
  for (const slot of graph.slots) {
    if (!slot.params) continue;
    for (const k of Object.keys(slot.params)) {
      if (k.startsWith('_')) {
        errors.push(`slot[${slot.id}] ${slot.kernel}: param "${k}" looks internal-only (leading underscore); the snapshot encoder will not write it`);
      }
    }
  }

  return errors;
}

module.exports = { lower, verify, HW_JACKS };
