'use strict';

// Snapshot encoder/decoder for Lens.
// encode(scheduled, graph) -> Uint8Array
// decode(bytes) -> { sampleRate, buffers, terminals }
//
// Wire layout (all little-endian):
//   HEADER (16 bytes)
//   KERNEL REGISTRY
//   SLOT TABLE (every slot in walk order)
//   BUFFER TABLE
//   TERMINAL TABLE
//   CRC32 (4 bytes, IEEE 802.3)

const MAGIC = [0x4C, 0x45, 0x4E, 0x53, 0x32]; // snapshot wire magic, 5 bytes; matches LENS_MAGIC in runtime/snapshot_format.h
const VERSION = 10;

// SPEC: jack id encoding.
const JACK_IDS = {
  'audio-out-1': 0, 'audio-out-2': 1,
  'cv-out-1': 2,    'cv-out-2': 3,
  'pulse-out-1': 4, 'pulse-out-2': 5,
  'led-0': 6, 'led-1': 7, 'led-2': 8,
  'led-3': 9, 'led-4': 10, 'led-5': 11,
};
const JACK_NAMES = Object.fromEntries(Object.entries(JACK_IDS).map(([k, v]) => [v, k]));

// SPEC: in_ref tag encoding.
const TAG_SLOT             = 0;
const TAG_BUFFER           = 1;
const TAG_CONST_U8         = 2;
const TAG_CONST_I32        = 3;
const TAG_SLOT_OUT2        = 4; /* slot ref pointing at a producer's second output (+4): recordhead head_pos, phasor tick */

// SPEC: buffer kind encoding.
const BUF_KINDS = { tape: 0, audio: 1, lens: 2 };
const BUF_KIND_NAMES = ['tape', 'audio', 'lens'];

// SPEC: param0 holds the one structural word a kernel needs (mode/jack/port/mask/
// seed/flags). Every other value a kernel reads is an input.
// An explicit 'param0' key maps directly; otherwise a single named kwarg folds in.
// A nonzero p1 is a compile error (asserted at the write site).
function encodeParams(params) {
  if (!params) return [0, 0];
  if ('param0' in params || 'param1' in params) {
    return [(params.param0 ?? 0) >>> 0, (params.param1 ?? 0) >>> 0];
  }
  const keys = Object.keys(params).sort();
  const p0 = keys.length > 0 ? (params[keys[0]] >>> 0) : 0;
  const p1 = keys.length > 1 ? (params[keys[1]] >>> 0) : 0;
  return [p0, p1];
}

// ---- CRC-32 IEEE 802.3 (polynomial 0xEDB88320) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- Writer ----
class Writer {
  constructor() { this._buf = []; }
  u8(v) { this._buf.push(v & 0xFF); }
  u16(v) { this.u8(v); this.u8(v >> 8); }
  u32(v) { const u = v >>> 0; this.u8(u); this.u8(u>>8); this.u8(u>>16); this.u8(u>>24); }
  i32(v) { this.u32(v >>> 0); }
  bytes() { return new Uint8Array(this._buf); }
  len() { return this._buf.length; }
}

// ---- Reader ----
class Reader {
  constructor(bytes) { this._b = bytes; this._p = 0; }
  u8() { return this._b[this._p++]; }
  u16() { const v = this._b[this._p] | (this._b[this._p+1]<<8); this._p+=2; return v; }
  u32() { const v = (this._b[this._p]|(this._b[this._p+1]<<8)|(this._b[this._p+2]<<16)|((this._b[this._p+3]<<24)>>>0)); this._p+=4; return v>>>0; }
  i32() { return this.u32() | 0; }
  str(n) { const s = String.fromCharCode(...this._b.slice(this._p, this._p+n)); this._p+=n; return s; }
  pos() { return this._p; }
  remaining() { return this._b.length - this._p; }
}

// ---- Pool limits (mirror C constants in runtime.h) ----
const LENS_AUDIO_BUFFER_BYTES   = 128 * 1024;  /* matches runtime.h; cells are 12-bit packed */
const LENS_CONTROL_BUFFER_BYTES = 1024;
const LENS_MAX_SLOTS            = 256;
const LENS_NODESTATE_BYTES      = 4 * 1024;
const LENS_MAX_BUFFERS          = 16;
const LENS_MAX_TERMINALS        = 16;
const LENS_CONST_POOL_WORDS     = 64;

// ---- Encoder ----
function encode(scheduled, graph) {
  // scheduled = { sampleRate, writerMap, violations, terminalFeedReport, budget, mode, dual }
  // graph = { slots, buffers, terminals }

  // Single-writer enforcement: the scheduler verifier guarantees each slot's
  // state fields are owned by exactly one writer. Reject snapshots that violate
  // this contract before encoding, since the dual-core runtime relies on it.
  if (scheduled.violations && scheduled.violations.length > 0) {
    const lines = scheduled.violations.map(v =>
      `  slot ${v.slot} field "${v.field}" (kind: ${v.kind}, other: ${v.otherSlot})`
    ).join('\n');
    throw new Error(`single-writer violation(s) — cannot encode dual-core snapshot:\n${lines}`);
  }

  const slotMap = new Map(graph.slots.map(s => [s.id, s]));

  // Every slot in walk (topological) order.
  const allEntries = scheduled.sampleRate;

  // Build kernel registry (unique names in walk order of first appearance).
  const kernelNames = [];
  const kernelIndex = new Map();
  for (const entry of allEntries) {
    const slot = slotMap.get(entry.slotId);
    const name = slot ? slot.kernel : 'op_unknown';
    if (!kernelIndex.has(name)) {
      kernelIndex.set(name, kernelNames.length);
      kernelNames.push(name);
    }
  }

  // Also register kernels for terminal slots (they're already in allEntries, but double-check).
  // (terminals reference slot_ids which are all in allEntries, so no extra work needed.)

  // Buffer id -> index (already sequential from lowerer, but use explicit map).
  const bufIndex = new Map(graph.buffers.map((b, i) => [b.id, i]));

  // Original slot id -> walk-order index (for in_ref and terminal resolution).
  // SPEC: C runtime indexes into its slot array by walk-order; in_refs carry walk-order.
  const walkOrderOf = new Map(allEntries.map((e, i) => [e.slotId, i]));

  // ---- Write ----
  const w = new Writer();

  // HEADER (16 bytes).
  for (const b of MAGIC) w.u8(b);
  w.u16(VERSION);
  w.u16(0); // flags (reserved)
  w.u16(allEntries.length);  // slot_count
  w.u16(0);                  // reserved
  w.u16(0);                  // reserved
  w.u8(graph.buffers.length); // buffer_count
  w.u8(graph.terminals.length); // terminal_count
  w.u8(kernelNames.length);   // kernel_id_count
  w.u8(0); // reserved

  // KERNEL REGISTRY.
  for (const name of kernelNames) {
    const encoded = Array.from(name).map(c => c.charCodeAt(0));
    w.u8(encoded.length);
    for (const b of encoded) w.u8(b);
  }

  function writeSlotRecord(entry) {
    const slot = slotMap.get(entry.slotId);
    if (!slot) throw new Error(`slot ${entry.slotId} not found in graph`);
    const kid = kernelIndex.get(slot.kernel) ?? 0;
    const core = entry.core;
    const ins = slot.in || [];

    w.u8(kid);
    w.u8(core);
    w.u8(ins.length);

    for (const ref of ins) {
      if (ref.kind === 'slot') {
        w.u8(ref.read ? TAG_SLOT_OUT2 : TAG_SLOT);
        w.u16(walkOrderOf.get(ref.id) ?? 0); /* walk-order index, not original slot id */
      } else if (ref.kind === 'buffer') {
        w.u8(TAG_BUFFER);
        w.u16(bufIndex.get(ref.id) ?? 0);
      } else if (ref.kind === 'const') {
        const v = Math.round(ref.value); /* the const pool is int32 */
        if (v >= 0 && v <= 255) {
          w.u8(TAG_CONST_U8);
          w.u8(v);
        } else {
          w.u8(TAG_CONST_I32);
          w.i32(v);
        }
      }
    }

    w.u16(0); /* out_offset: runtime computes from sizeof; write 0 */
    const [p0, p1] = encodeParams(slot.params);
    if (p1 !== 0) throw new Error(`${slot.kernel}: param1 is retired; structural data must fit param0`);
    w.u32(p0);
  }

  // SLOT TABLE: every slot in walk order.
  for (const entry of allEntries) writeSlotRecord(entry);

  // BUFFER TABLE.
  for (const buf of graph.buffers) {
    w.u8(BUF_KINDS[buf.kind] ?? 0);
    w.u32(buf.length); // SPEC: u32 to handle audio buffers > 65535 cells
    const hasSeed = buf.seed && buf.seed.length > 0 ? 1 : 0;
    w.u8(hasSeed);
    if (hasSeed) {
      for (let i = 0; i < buf.length; i++) {
        w.u16(buf.seed[i] ?? 0);
      }
    }
  }

  // TERMINAL TABLE.
  for (const term of graph.terminals) {
    w.u8(JACK_IDS[term.jack] ?? 0);
    w.u16(walkOrderOf.get(term.slotId) ?? 0); /* walk-order index */
    w.u8(term.mode ?? 0);                      /* 0=raw, 1=v/oct pitch (cv-out) */
  }

  // CRC32.
  const body = w.bytes();
  const crc = crc32(body);
  w.u32(crc);

  // Pool validation: reject patches that exceed static pool limits.
  const slotCount = allEntries.length;
  if (slotCount > LENS_MAX_SLOTS)
    throw new Error(`patch exceeds LENS_MAX_SLOTS (used ${slotCount}, limit ${LENS_MAX_SLOTS})`);
  if (graph.buffers.length > LENS_MAX_BUFFERS)
    throw new Error(`patch exceeds LENS_MAX_BUFFERS (used ${graph.buffers.length}, limit ${LENS_MAX_BUFFERS})`);
  if (graph.terminals.length > LENS_MAX_TERMINALS)
    throw new Error(`patch exceeds LENS_MAX_TERMINALS (used ${graph.terminals.length}, limit ${LENS_MAX_TERMINALS})`);
  let audioBytes = 0, controlBytes = 0, constCount = 0;
  for (const buf of graph.buffers) {
    /* 12-bit packed: 2 cells per 3 bytes; round up. */
    const bytesPacked = (buf.length * 3 + 1) >> 1;
    if (buf.kind === 'audio') audioBytes += bytesPacked;
    else controlBytes += bytesPacked;
  }
  for (const entry of allEntries) {
    const slot = slotMap.get(entry.slotId);
    if (slot) {
      for (const ref of (slot.in || [])) if (ref.kind === 'const') constCount++;
    }
  }
  if (audioBytes > LENS_AUDIO_BUFFER_BYTES)
    throw new Error(`patch exceeds LENS_AUDIO_BUFFER_BYTES (used ${audioBytes}, limit ${LENS_AUDIO_BUFFER_BYTES})`);
  if (controlBytes > LENS_CONTROL_BUFFER_BYTES)
    throw new Error(`patch exceeds LENS_CONTROL_BUFFER_BYTES (used ${controlBytes}, limit ${LENS_CONTROL_BUFFER_BYTES})`);
  if (constCount > LENS_CONST_POOL_WORDS)
    throw new Error(`patch exceeds LENS_CONST_POOL_WORDS (used ${constCount}, limit ${LENS_CONST_POOL_WORDS})`);

  return w.bytes();
}

// ---- Decoder ----
function decode(bytes) {
  const r = new Reader(bytes);

  // HEADER.
  const magic = [r.u8(), r.u8(), r.u8(), r.u8(), r.u8()];
  if (!MAGIC.every((b, i) => magic[i] === b)) throw new Error(`bad magic: ${JSON.stringify(magic)}`);
  const version = r.u16();
  if (version !== VERSION) throw new Error(`version mismatch: got ${version}, want ${VERSION}`);
  r.u16(); // flags
  const slot_count = r.u16();
  r.u16(); // reserved
  r.u16(); // reserved
  const buffer_count = r.u8();
  const terminal_count = r.u8();
  const kernel_id_count = r.u8();
  r.u8(); // reserved

  // KERNEL REGISTRY.
  const kernelNames = [];
  for (let i = 0; i < kernel_id_count; i++) {
    const len = r.u8();
    kernelNames.push(r.str(len));
  }

  // SLOT TABLE: flat list of slot_count records in walk order.
  function readSlotRecord(walkIdx) {
    const kid = r.u8();
    const core = r.u8();
    const in_count = r.u8();

    const ins = [];
    for (let j = 0; j < in_count; j++) {
      const tag = r.u8();
      if (tag === TAG_SLOT) {
        ins.push({ kind: 'slot', id: r.u16() });
      } else if (tag === TAG_SLOT_OUT2) {
        ins.push({ kind: 'slot', id: r.u16(), read: 'out2' });
      } else if (tag === TAG_BUFFER) {
        ins.push({ kind: 'buffer', id: r.u16() });
      } else if (tag === TAG_CONST_U8) {
        ins.push({ kind: 'const', value: r.u8() });
      } else if (tag === TAG_CONST_I32) {
        ins.push({ kind: 'const', value: r.i32() });
      } else {
        throw new Error(`unknown in_ref tag ${tag}`);
      }
    }

    const out_offset = r.u16();
    const param0 = r.u32();

    const kernel = kernelNames[kid] ?? 'op_unknown';
    return {
      slotId: walkIdx, // walk-order index (not original slot id)
      kernel,
      core,
      in: ins,
      out_offset,
      param0,
    };
  }

  const sampleRate = [];
  let walkIdx = 0;
  for (let i = 0; i < slot_count; i++) {
    sampleRate.push(readSlotRecord(walkIdx++));
  }

  // BUFFER TABLE.
  const buffers = [];
  for (let i = 0; i < buffer_count; i++) {
    const kindByte = r.u8();
    const length = r.u32();
    const hasSeed = r.u8();
    const buf = { id: i, kind: BUF_KIND_NAMES[kindByte] ?? 'tape', length };
    if (hasSeed) {
      const seed = [];
      for (let j = 0; j < length; j++) seed.push(r.u16());
      buf.seed = seed;
    }
    buffers.push(buf);
  }

  // TERMINAL TABLE.
  const terminals = [];
  for (let i = 0; i < terminal_count; i++) {
    const jackId = r.u8();
    const slotId = r.u16();
    const mode   = r.u8();
    terminals.push({ jack: JACK_NAMES[jackId] ?? `jack-${jackId}`, slotId, mode });
  }

  // CRC32.
  const bodyLen = r.pos();
  const storedCrc = r.u32();
  const computedCrc = crc32(bytes.slice(0, bodyLen));
  if (storedCrc !== computedCrc) {
    throw new Error(`CRC mismatch: stored 0x${storedCrc.toString(16)}, computed 0x${computedCrc.toString(16)}`);
  }

  return {
    sampleRate,
    buffers,
    terminals,
    _kernelNames: kernelNames,
  };
}

module.exports = { encode, decode, MAGIC, VERSION, JACK_IDS, JACK_NAMES, TAG_SLOT, TAG_BUFFER, TAG_CONST_U8, TAG_CONST_I32, BUF_KINDS, crc32 };
