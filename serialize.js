// serialize.js: compiled patch <-> wire/flash snapshot bytes. Field order mirrors snapshot.h.
'use strict';

const { KIND_ENUM, KNODEPOOL, KMAXGRAPHLITERALS, CONTROL_BYTES } = require('./nodes.js');
const { computeIntervals, wirePeriod } = require('./intervals.js');

const SAVE_VERSION = 0x00050006;   // must match kSaveVersion in main.cpp

function serializeSnapshot(p) {
  const buf = new ArrayBuffer(64 * 1024);
  const dv = new DataView(buf);
  let o = 0;
  const u8  = v => { dv.setUint8(o, v & 0xFF); o += 1; };
  const i8  = v => { dv.setInt8(o, v | 0); o += 1; };
  const u16 = v => { dv.setUint16(o, v & 0xFFFF, true); o += 2; };
  const i16 = v => { dv.setInt16(o, v | 0, true); o += 2; };
  const u32 = v => { dv.setUint32(o, v >>> 0, true); o += 4; };
  const i32 = v => { dv.setInt32(o, v | 0, true); o += 4; };

  const kindNum = (k) => {
    const n = KIND_ENUM.get(k);
    if (n === undefined) throw new Error('serializeSnapshot: unknown node kind "' + k + '" (not in the expression.h enum map)');
    return n;
  };

  for (const c of 'LENS') u8(c.charCodeAt(0));
  u32(SAVE_VERSION);

  // control region only; audio is not saved
  let ctrlLen = Math.min(p.buffer.length, CONTROL_BYTES);
  while (ctrlLen > 0 && (p.buffer[ctrlLen - 1] | 0) === 0) ctrlLen--;
  u16(ctrlLen);
  for (let i = 0; i < ctrlLen; i++) u8(p.buffer[i] | 0);

  const tapes = p.tapes || [];
  u8(tapes.length);
  for (const t of tapes) {
    u32(t.start | 0); u32(t.length | 0);
    i8(t.drift | 0);
    u8(t.ymod | 0); u8((t.variety ?? 128) & 0xFF); u8(t.frozen | 0); u8(t.inputrole | 0);
    u32(t.clockDiv | 0);
    i32(t.main_stored ?? 512); i32(t.x_stored ?? 900); i32(t.y_stored ?? 2048);
  }

  i32(p.master.main ?? 1024); i32(p.master.x ?? 1024); i32(p.master.y ?? 2048);
  u8((p.active_page | 0) & 0xFF);

  const nodes = p.graph.nodes, lits = p.graph.literals;
  if (nodes.length > KNODEPOOL) throw new Error('graph too long for snapshot: ' + nodes.length + ' nodes');
  if (lits.length > KMAXGRAPHLITERALS) throw new Error('too many literal tapes for snapshot: ' + lits.length);
  const P = computeIntervals(nodes);
  u16(nodes.length);
  u8(lits.length);
  for (const l of lits) { u32(l.start); u32(l.length); }
  nodes.forEach((f, i) => {
    u8(kindNum(f.kind));
    i16(f.array_idx); i16(f.in_a); i16(f.in_b);
    i16(f.param | 0);
    i16(f.param_from); i16(f.clock_from); i16(f.branch_start); i16(f.branch_count);
    u8(f.is_signal | 0);
    u32(wirePeriod(P[i]));
  });

  const T = p.terminals;
  for (let j = 0; j < 6; j++) i16(T.jack[j] ?? -1);
  for (let l = 0; l < 6; l++) i16(T.led[l] ?? -1);
  i16(T.reset ?? -1); i16(T.clock_in ?? -1);
  const rec = T.rec || [];
  u8(rec.length);
  for (const r of rec) { i8(r.tape); i16(r.terminal); }

  return new Uint8Array(buf.slice(0, o));
}

// Mirror of serializeSnapshot.
function decodeSnapshot(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u8  = () => dv.getUint8(o++); const i8 = () => dv.getInt8(o++);
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const i16 = () => { const v = dv.getInt16(o, true); o += 2; return v; };
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };

  const magic = String.fromCharCode(u8(), u8(), u8(), u8());
  if (magic !== 'LENS') throw new Error('bad magic: ' + magic);
  const version = u32();
  if (version !== SAVE_VERSION) throw new Error('version mismatch: 0x' + version.toString(16)
    + ' (this build speaks 0x' + SAVE_VERSION.toString(16) + ')');

  const ctrlLen = u16();
  const control = new Uint8Array(bytes.buffer, bytes.byteOffset + o, ctrlLen).slice(); o += ctrlLen;

  const tapes = [];
  const tapeCount = u8();
  for (let t = 0; t < tapeCount; t++)
    tapes.push({ start: u32(), length: u32(), drift: i8(), ymod: u8(), variety: u8(),
                 frozen: u8(), inputrole: u8(), clockDiv: u32(),
                 main_stored: i32(), x_stored: i32(), y_stored: i32() });

  const master = { main: i32(), x: i32(), y: i32() };
  const active_page = u8();

  const nodeCount = u16(), litCount = u8();
  const literals = [];
  for (let l = 0; l < litCount; l++) literals.push({ start: u32(), length: u32() });
  const KIND_NAME = new Map([...KIND_ENUM.entries()].map(([k, n]) => [n, k]));
  const nodes = [];
  for (let i = 0; i < nodeCount; i++)
    nodes.push({ kind: KIND_NAME.get(u8()), array_idx: i16(), in_a: i16(), in_b: i16(),
                 param: i16(), param_from: i16(), clock_from: i16(),
                 branch_start: i16(), branch_count: i16(), is_signal: !!u8(), period: u32() });

  const terminals = { jack: [], led: [], reset: -1, clock_in: -1, rec: [] };
  for (let j = 0; j < 6; j++) terminals.jack.push(i16());
  for (let l = 0; l < 6; l++) terminals.led.push(i16());
  terminals.reset = i16(); terminals.clock_in = i16();
  const recCount = u8();
  for (let r = 0; r < recCount; r++) terminals.rec.push({ tape: i8(), terminal: i16() });

  return { version, control, tapes, master, active_page, graph: { nodes, literals }, terminals };
}

module.exports = { serializeSnapshot, decodeSnapshot, SAVE_VERSION };
