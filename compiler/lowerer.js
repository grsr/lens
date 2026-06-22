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

  function allocBuffer(kind, length, seed) {
    const id = nextBufId++;
    const entry = { id, kind, length };
    if (seed !== undefined) entry.seed = seed;
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
      // chain: stages are piped; last stage's output is the result.
      case 'chain':   return lowerChain(node);
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
    // (mix a b ... :levels '(w0 w1 ...)): weighted mix, normalised to the weight
    // sum so the output stays bounded. Expands to a sum of vca'd inputs; no kernel.
    if (op === 'mix' && kwargs.levels &&
        (kwargs.levels.t === 'quote' || kwargs.levels.t === 'list')) {
      const inputs = args.map(lowerNode);
      const ws = kwargs.levels.items.map(it => (it.t === 'num' ? it.v : 0));
      if (ws.length !== inputs.length) {
        throw new Error(`(mix ... :levels): ${ws.length} levels for ${inputs.length} inputs`);
      }
      const sum = ws.reduce((a, b) => a + b, 0) || 1;
      const scaled = inputs.map((ref, i) =>
        allocSlot('op_vca', [ref, { kind: 'const', value: Math.round(ws[i] * 4095 / sum) }], {}, {}));
      if (scaled.length === 1) return scaled[0];
      return allocSlot('op_add', scaled, {}, {}); // post-pass folds >2 into an add2 tree
    }
    // Variadic ops that chain into binary pairs.
    if (op === 'mix' || op === 'add' || op === 'mul' || op === 'or' || op === 'and') {
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
        // phase-driven (bit 4).
        const pmRef    = kwargs.pm    ? lowerNode(kwargs.pm)    : null;
        const depthRef = kwargs.depth ? lowerNode(kwargs.depth) : null;
        let param0 = mode & 3;
        if (phaseRef) param0 |= 16;
        if (pmRef)    param0 |= 4;
        if (depthRef) param0 |= 8;
        const sineIns = [phaseRef || rateRef];
        if (pmRef)    sineIns.push(pmRef);
        if (depthRef) { if (!pmRef) sineIns.push({ kind: 'const', value: 0 }); sineIns.push(depthRef); }
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
    const seed = node.items.map(item => {
      if (item.t === 'num') return item.v;
      // _ and ~ are score rest/hold markers; they lower to 0.
      if (item.t === 'sym' && (item.s === '_' || item.s === '~')) return 0;
      if (item.t === 'sym') throw new Error(`unknown name: ${item.s}`);
      return 0;
    });
    const ref = allocBuffer('tape', seed.length, seed);
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
    return allocSlot('op_morph', ins, {}, {});
  }

  function lowerOutputsNode(node) {
    if (node.ports && node.ports.length > 0) {
      return lowerNode(node.ports[0].value);
    }
    return { kind: 'const', value: 0 };
  }

  function lowerChain(node) {
    const stages = node.stages || [];
    if (stages.length === 0) return { kind: 'const', value: 0 };
    if (stages.length === 1) return lowerNode(stages[0]);

    let prevRef = lowerNode(stages[0]);

    for (let i = 1; i < stages.length; i++) {
      const stage = stages[i];
      if (stage.t === 'call') {
        const kernel = chooseKernel(stage.op, stage.kwargs);
        const stageIns = [prevRef, ...stage.args.map(lowerNode)].slice(0, 5);
        const params = {};
        const flags = [];
        for (const [k, v] of Object.entries(stage.kwargs)) {
          if (v.t === 'num') params[k] = v.v;
          else if (v.t === 'flag') flags.push(k);
        }
        const meta = flags.length ? { flags } : {};
        prevRef = allocSlot(kernel, stageIns, params, meta);
      } else {
        prevRef = lowerNode(stage);
      }
    }
    return prevRef;
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

    // Scatter sink: route X to the sel-th jack of the family.
    if (sink.t === 'jackscatter') {
      const family = JACK_LABELS[sink.jack];
      const N = family.length;
      const valRef = lowerNode(value);
      const selRef = lowerNode(sink.selector);
      const kRef    = { kind: 'const', value: N };
      const mod1    = allocSlot('op_mod', [selRef, kRef], {}, { state: [] });
      const addK    = allocSlot('op_add', [mod1, kRef], {}, { state: [] });
      const wrapped = allocSlot('op_mod', [addK, kRef], {}, { state: [] });
      for (let i = 0; i < N; i++) {
        const jackName = `${sink.jack}-${family[i]}`;
        const iRef  = { kind: 'const', value: i };
        const cond  = allocSlot('op_eq', [wrapped, iRef], {}, { state: [] });
        const normal = jackNormals.get(jackName);
        const elseRef = normal ? lowerNode(normal) : { kind: 'const', value: 0 };
        const drive = allocSlot('op_if', [cond, valRef, elseRef], {}, { state: [] });
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

    // Buffer sink (tape / audio / lens).
    emitRecordhead(sink, value, kwargs);
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
    if (value.t === 'chain') {
      return lowerChain(value);
    }
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

  return { buffers, slots, terminals };
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
