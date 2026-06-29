'use strict';

const fs   = require('fs');
const path = require('path');
const { read } = require('./reader.js');

const REPO = path.resolve(__dirname, '..');

// Internal kernels legitimately present in impl but not declared in prelude.
const KNOWN_INTERNAL = new Set([
  // op_edge is the canonical rising-edge kernel; trig lowers to it.
  // op_trig entry remains in the C KTABLE for backward snapshot compatibility.
  'op_edge', 'op_trig',
  // terminal writes
  'op_terminal_write_audio_out_1', 'op_terminal_write_audio_out_2',
  'op_terminal_write_cv_out_1',    'op_terminal_write_cv_out_2',
  'op_terminal_write_pulse_out_1', 'op_terminal_write_pulse_out_2',
  'op_terminal_write_led_0', 'op_terminal_write_led_1', 'op_terminal_write_led_2',
  'op_terminal_write_led_3', 'op_terminal_write_led_4', 'op_terminal_write_led_5',
  // recordhead variants
  'op_recordhead_per_sample', 'op_recordhead_per_cell', 'op_recordhead_gated',
  'op_recordhead_len_capped', 'op_recordhead_len_capped_gated', 'op_recordhead_seek',
  // wave variants
  'op_wave', 'op_wave_drumrack',
  // variadic-collapsed binary ops
  'op_mix2', 'op_add2', 'op_mul2', 'op_and2', 'op_or2',
  // :sat saturating arithmetic variants of add/sub
  'op_add_sat', 'op_sub_sat',
  // structural / synthetic
  'op_connected', 'op_stub', 'op_morph',
  // MIDI leaf (midi_scratch reader; parallel to op_knob for hw_scratch)
  'op_midi',
  // MIDI output sinks (side-effecting roots, no terminal entry)
  'op_midi_note_out', 'op_midi_cc_out', 'op_midi_clock_out',
]);

// Collect names of primitive fns in prelude: (def NAME (fn (...) <meta-only body>)).
function collectPreludePrimitives(preludeText) {
  const ast  = read(preludeText);
  const out  = [];
  for (const form of ast) {
    if (form.t !== 'list' || form.items.length < 3) continue;
    if (form.items[0].t !== 'sym' || form.items[0].s !== 'def') continue;
    const nameNode  = form.items[1];
    if (nameNode.t !== 'sym') continue;
    const valueNode = form.items[2];
    if (valueNode.t !== 'list' || valueNode.items.length === 0) continue;
    const head = valueNode.items[0];
    if (head.t !== 'sym' || head.s !== 'fn') continue;
    // body starts at index 2 (after fn + params list).
    const body = valueNode.items.slice(2);
    // Primitive: body is empty OR consists only of kw/value meta pairs.
    let isPrim = true;
    let i = 0;
    while (i < body.length) {
      const f = body[i];
      if (f.t === 'kw') {
        i++;
        if (i < body.length && body[i].t !== 'kw') i++;
        continue;
      }
      isPrim = false;
      break;
    }
    if (isPrim) out.push(nameNode.s);
  }
  return out;
}

// Collect kernel names from the C KTABLE in runtime.c.
function collectCKernels() {
  const text    = fs.readFileSync(path.join(__dirname, '..', 'runtime/runtime.c'), 'utf8');
  const matches = [...text.matchAll(/"(op_\w+)"/g)];
  return [...new Set(matches.map(m => m[1]))];
}

// Prelude verbs the expander rewrites to other kernels, so they have no backing
// op_ of their own. groove -> mix of drum voices.
const EXPANDER_SUGAR = new Set(['groove', 'tape', 'audio', 'score', 'normal']);

// Prelude primitives that lower to a kernel with a different name.
// trig (a clock's beat) lowers to op_fall (the ramp's wrap); edge is the rising kernel.
const KERNEL_OVERRIDE = { trig: 'op_fall', lpf2: 'op_svf', hpf2: 'op_svf', bpf2: 'op_svf',
                          wt: 'op_wavetable' };

// Convert a prelude name like 'v-oct' -> 'op_v_oct'.
function primToKernel(name) {
  if (KERNEL_OVERRIDE[name]) return KERNEL_OVERRIDE[name];
  // MIDI leaf verbs (midi-note/gate/cc/trig/...) all read midi_scratch via op_midi.
  if (name.startsWith('midi-')) return 'op_midi';
  return 'op_' + name.replace(/-/g, '_');
}

function validatePreludeKernels() {
  const preludeText = fs.readFileSync(path.join(REPO, 'prelude.loupe'), 'utf8');
  const primitives  = collectPreludePrimitives(preludeText);
  const cKernels    = new Set(collectCKernels());

  const expectedKernels = primitives
    .filter(p => !EXPANDER_SUGAR.has(p))
    .map(primToKernel);

  const missingC  = expectedKernels.filter(k => !cKernels.has(k));
  const extraC    = [...cKernels].filter(k => !expectedKernels.includes(k) && !KNOWN_INTERNAL.has(k));

  return { primitives, expectedKernels, cKernels: [...cKernels], missingC, extraC };
}

module.exports = { validatePreludeKernels, collectPreludePrimitives };

// CLI: node compiler/validate.js
if (require.main === module) {
  const v = validatePreludeKernels();
  console.log(`prelude primitives : ${v.primitives.length}`);
  console.log(`C runtime kernels  : ${v.cKernels.length}`);
  const ok = !v.missingC.length && !v.extraC.length;
  if (v.missingC.length)  console.error('MISSING from C runtime:\n' + v.missingC.map(k => '  ' + k).join('\n'));
  if (v.extraC.length)    console.warn('EXTRA in C  (not in prelude, not KNOWN_INTERNAL):\n' + v.extraC.map(k => '  ' + k).join('\n'));
  if (ok) console.log('ok: no drift');
  process.exit(ok ? 0 : 1);
}
