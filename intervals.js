// intervals.js: post-compile rate and signal-domain analysis over the node array.
'use strict';

const { NODE_INTERVAL, SIGNAL_KINDS, EVERY_SAMPLE, EVERY_BEAT, EVERY_CTRL, NEVER, VMAX } = require('./nodes.js');

const sourceInterval = (f) =>
    NODE_INTERVAL.has(f.kind) ? NODE_INTERVAL.get(f.kind)
  : (f.kind === 'feedback' || f.kind === 'z1') ? EVERY_SAMPLE
  : null;

// Slow-source analysis: compile-time max rate (Hz); provably-slow chains run at control cadence.
const TEMPO_TOP_HZ   = 29;
const SLOW_SOURCE_HZ = 64;
const PURE_KINDS = new Set(['transpose', 'invert', 'add', 'sub', 'mul', 'div', 'mod',
  'spread', 'shift', 'xor', 'and', 'or', 'mask', 'bit', 'gt', 'gte', 'lt', 'lte',
  'eq', 'ne', 'max', 'min', 'abs', 'rect', 'crush', 'snap']);
const rateHz = (b) => 0.05 * Math.pow(20000 / 0.05, (b & 0xFF) / 255);   // mirrors rate_table

function computeMaxHz(nodes) {
  const n = nodes.length;
  const H = new Array(n).fill(Infinity);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < n; i++) {
      const f = nodes[i];
      let h = Infinity;
      if (f.kind === 'const') h = 0;
      else if (f.kind === 'phasor') {
        const mode = (f.param || 0) & 3;
        if (mode === 2 && typeof f._hz === 'number') h = Math.abs(f._hz);
        else if (mode === 1 && f.in_a >= 0 && f.in_a < i && nodes[f.in_a].kind === 'const')
          h = rateHz(((nodes[f.in_a].param || 0) >> 4) & 0xFF);
        else if (mode === 3) h = TEMPO_TOP_HZ;
      }
      else if (f.kind === 'follow' && f.in_a >= 0 && f.in_a < i) h = H[f.in_a] * 2;
      else if (PURE_KINDS.has(f.kind)) {
        h = 0;
        for (const j of [f.in_a, f.in_b, f.param_from])
          if (j >= 0) h = Math.max(h, j < i ? H[j] : Infinity);   // forward ref = feedback
      }
      if (h < H[i]) H[i] = h;
    }
  }
  return H;
}

function computeIntervals(nodes) {
  const n = nodes.length;
  const P = new Array(n).fill(NEVER);
  const H = computeMaxHz(nodes);
  // Provably-slow streams run at control cadence, not interval-1.
  const imposed = (j) => (P[j] === EVERY_SAMPLE && H[j] <= SLOW_SOURCE_HZ) ? EVERY_CTRL : P[j];
  const inputs = (f) => [f.in_a, f.in_b, f.param_from, f.clock_from].filter(i => i >= 0 && i < n);
  let changed = true, guard = 0;
  while (changed && guard++ <= n + 4) {
    changed = false;
    for (let i = 0; i < n; i++) {
      const f = nodes[i];
      const sp = sourceInterval(f);
      let p;
      if (f.kind === 'shape') {
        // Inherits phase's interval; a fused note (non-phasor in_a) is audio-rate.
        const a = f.in_a;
        p = (a >= 0 && a < n && nodes[a].kind === 'phasor') ? P[a] : EVERY_SAMPLE;
        for (const j of [f.in_b, f.clock_from].filter(x => x >= 0 && x < n)) p = Math.min(p, P[j]);
      } else if (sp !== null) {
        p = sp;
          // Clocked reads: track data inputs but not clock_from (runtime self-gates on wraps).
        if (f.kind === 'lookup' || f.kind === 'arrange' || f.kind === 'counter')
          for (const j of [f.in_a, f.in_b, f.param_from].filter(x => x >= 0 && x < n))
            p = Math.min(p, P[j]);
      } else if (PURE_KINDS.has(f.kind)) {
        p = NEVER;
        for (const j of inputs(f)) p = Math.min(p, imposed(j));
      } else {
        p = NEVER;
        for (const j of inputs(f)) p = Math.min(p, P[j]);
      }
      // switch: as fast as the fastest branch.
      if (f.branch_count > 0 && f.branch_start >= 0)
        for (let k = 0; k < f.branch_count; k++)
          if (f.branch_start + k < n) p = Math.min(p, P[f.branch_start + k]);
      // Forward/self reference = z^-1 feedback: interval 1.
      for (const j of [f.in_a, f.in_b, f.param_from, f.clock_from])
        if (j >= i && j < n) p = EVERY_SAMPLE;
      if (p < P[i]) { P[i] = p; changed = true; }
    }
  }
  return P;
}

const periodLabel = (p) => p === EVERY_SAMPLE ? 'SAMPLE' : p === NEVER ? 'static'
  : p === EVERY_BEAT ? 'beat' : p === EVERY_CTRL ? 'ctrl' : `${p}smp`;

// NEVER_WIRE mirrors kNever in expression.h.
const NEVER_WIRE = 0x7FFFFFFF;
const wirePeriod = (p) => Number.isFinite(p) ? p : NEVER_WIRE;

// Domain inference: monotone fixpoint over Node.is_signal.
function computeIsSignal(nodes) {
  const n = nodes.length;
  const S = new Array(n).fill(false);
  let changed = true, guard = 0;
  while (changed && guard++ <= n + 4) {
    changed = false;
    for (let i = 0; i < n; i++) {
      const f = nodes[i];
      let s;
      if (SIGNAL_KINDS.has(f.kind)) s = true;
      else if (f.kind === 'mul' && (f.array_idx === 2 || f.array_idx === 3 || f.array_idx === 4)) s = true;
      // Pass-through: signal if any operand is.
      else if (['add','sub','mul','diff','crush','and','or','xor','mask','transpose'].includes(f.kind))
        s = [f.in_a, f.in_b, f.param_from].some(x => x >= 0 && x < n && S[x]);
      else if (f.kind === 'switch' && f.branch_count > 0) {
        // signal iff every branch is
        s = true;
        for (let k = 0; k < f.branch_count; k++)
          s = s && f.branch_start + k < n && S[f.branch_start + k];
      }
      else s = false;
      if (s && !S[i]) { S[i] = true; changed = true; }
    }
  }
  return S;
}

// Every time-dependent node must have clock_from wired by the compiler.
const NEEDS_CLOCK = new Set(['counter', 'random', 'walk', 'chance', 'arrange', 'envelope', 'tick', 'beats']);
function validateClocks(nodes) {
  nodes.forEach((f, i) => {
    if (NEEDS_CLOCK.has(f.kind) && !(f.clock_from >= 0))
      throw new Error(`compiler bug: ${f.kind} (node ${i}) emitted with no clock, every time-dependent form needs clock_from wired`);
    if (f.kind === 'lookup' && !(f.clock_from >= 0) && !(f.in_a >= 0))
      throw new Error(`compiler bug: lookup (node ${i}) has neither a clock (a head) nor an index, an unwired read`);
    if (f.kind === 'follow' && !(f.in_a >= 0))
      throw new Error(`compiler bug: follow (node ${i}) has no base clock`);
  });
}

// Bake is_signal, default mul mode, and validate clock wiring.
function finalize(nodes) {
  const S = computeIsSignal(nodes);
  nodes.forEach((f, i) => {
    f.is_signal = S[i] ? 1 : 0;
    if (f.kind === 'mul' && f.array_idx < 0) f.array_idx = 0;
  });
  validateClocks(nodes);
  return nodes;
}

module.exports = { computeIntervals, finalize, wirePeriod, periodLabel };
