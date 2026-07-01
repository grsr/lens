#!/usr/bin/env node
// cli/cli.js: send Lens patches to the card over USB MIDI SysEx.
//
//   node cli/cli.js ping                       handshake (expects ACK)
//   node cli/cli.js write <patch.loupe> [--save]  compile -> snapshot -> WRITE_STATE
//   node cli/cli.js save                        flash the live patch + reboot
//   node cli/cli.js factory-reset               erase flash, reboot to embedded default
//   node cli/cli.js perf                         read perf counters (expects PERF_DUMP)
//   node cli/cli.js slot-perf                    per-slot cycle breakdown (top 20 by total)
//   node cli/cli.js roundtrip <patch.loupe>     WRITE_STATE then READ_STATE; byte-exact
//   node cli/cli.js watch <patch.loupe>         live-coding loop: re-push on save
//   node cli/cli.js test [phase-a|phase-b|phase-c|phase-d|all|ping|corpus] [--report=<file>]
//
// Options:  --port <substr>   pick the MIDI port whose name contains <substr>
//                             (default: matches /lens|workshop|music thing/i)
'use strict';

const fs = require('fs');
const path = require('path');

const { compile } = require('../compiler/compile-pipeline');
const { decode } = require('../compiler/snapshot.js');
const { CMD, frame, parse } = require('./sysex.js');

let midi;
try { midi = require('@julusian/midi'); }
catch { console.error('Missing dependency. Run:  npm install'); process.exit(1); }

const DEFAULT_FILTER = /lens|workshop|music thing/i;
const REPO = path.resolve(__dirname, '..');

function pickPort(io, want) {
  const n = io.getPortCount();
  const names = [];
  for (let i = 0; i < n; i++) names.push(io.getPortName(i));
  const test = want ? s => s.toLowerCase().includes(want.toLowerCase()) : s => DEFAULT_FILTER.test(s);
  const idx = names.findIndex(test);
  if (idx < 0) {
    console.error(`No matching MIDI port. ${want ? `filter="${want}"` : 'default filter'}. Ports seen:`);
    names.forEach((s, i) => console.error(`  [${i}] ${s}`));
    process.exit(1);
  }
  return { idx, name: names[idx] };
}

async function withDevice(want, fn) {
  const out = new midi.Output();
  const inp = new midi.Input();
  const o = pickPort(out, want), i = pickPort(inp, want);
  out.openPort(o.idx);
  inp.openPort(i.idx);
  inp.ignoreTypes(false, true, true);

  let waiter = null;
  inp.on('message', (_dt, msg) => {
    const p = parse(msg);
    if (p && waiter) { const w = waiter; waiter = null; clearTimeout(w.timer); w.resolve(p); }
  });
  const recv = (ms = 3000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiter = null; reject(new Error('timeout waiting for card reply')); }, ms);
    waiter = { resolve, timer };
  });
  const send = (cmd, payload) => out.sendMessage([...frame(cmd, payload)]);

  console.error(`port: ${o.name}`);
  try { return await fn(send, recv); }
  finally { out.closePort(); inp.closePort(); }
}

function expectAck(p) {
  if (p.cmd === CMD.ACK) return;
  if (p.cmd === CMD.NACK) throw new Error(`card NACK (cmd 0x${(p.payload[0] || 0).toString(16)}, reason 0x${(p.payload[1] || 0).toString(16)})`);
  throw new Error(`unexpected reply 0x${p.cmd.toString(16)}`);
}

function loadFile(relpath) {
  const full = path.isAbsolute(relpath) ? relpath : path.join(REPO, relpath);
  return fs.readFileSync(full, 'utf8');
}

let _validated = false;
function snapshotFromPatch(file) {
  if (!_validated) {
    _validated = true;
    const { validatePreludeKernels } = require('../compiler/validate.js');
    const v = validatePreludeKernels();
    if (v.missingC.length) {
      throw new Error('Prelude/kernel drift: C runtime missing: ' + v.missingC.join(', '));
    }
  }
  return compile(file).snapshot;
}

async function writeState(send, recv, snapshot, tries = 4) {
  for (;;) {
    send(CMD.WRITE_STATE, snapshot);
    const p = await recv();
    if (p.cmd === CMD.ACK) return;
    if (p.cmd === CMD.NACK && p.payload[1] === 0x06 && --tries > 0) {
      await new Promise(r => setTimeout(r, 200));
      continue;
    }
    expectAck(p);
  }
}

function writeWav(samples, outPath, sampleRate = 48000) {
  const N = samples.length;
  const buf = Buffer.alloc(44 + N * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + N * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(N * 2, 40);
  for (let i = 0; i < N; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 16)));
    buf.writeInt16LE(v, 44 + i * 2);
  }
  fs.writeFileSync(outPath, buf);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const portArg = (() => { const k = rest.indexOf('--port'); return k >= 0 ? rest[k + 1] : undefined; })();
  const hasFlag = f => rest.includes(f);
  const flagVal = f => { const k = rest.indexOf(f); return k >= 0 ? rest[k + 1] : undefined; };
  const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--port' && rest[i - 1] !== '--samples' && rest[i - 1] !== '--at');
  // --at zero|beat|bar: when a live write swaps in (default zero = next near-zero sample).
  const swapMode = (() => {
    const v = flagVal('--at');
    if (v === undefined) return null;
    const m = { zero: 0, beat: 1, bar: 2 }[v];
    if (m === undefined) throw new Error('--at must be zero, beat, or bar');
    return m;
  })();
  const setSwapMode = async (send, recv) => {
    if (swapMode === null) return;
    send(CMD.SWAP_MODE, [swapMode]); expectAck(await recv());
  };

  switch (cmd) {
    case 'ping':
      await withDevice(portArg, async (send, recv) => { send(CMD.PING); expectAck(await recv()); console.log('pong (ACK)'); });
      break;

    case 'write': {
      const file = positional[0]; if (!file) throw new Error('usage: write <patch.loupe> [--save]');
      const save = hasFlag('--save');
      const snapshot = snapshotFromPatch(file);
      await withDevice(portArg, async (send, recv) => {
        await setSwapMode(send, recv);
        await writeState(send, recv, snapshot);
        if (save) {
          await new Promise(r => setTimeout(r, 700));
          send(CMD.SAVE_STATE); expectAck(await recv());
        }
      });
      console.log(save
        ? `wrote + saved ${file} (${snapshot.length} B), card flashing + rebooting.`
        : `wrote ${file} (${snapshot.length} B snapshot), live (not saved).`);
      break;
    }

    case 'save':
      await withDevice(portArg, async (send, recv) => { send(CMD.SAVE_STATE); expectAck(await recv()); });
      console.log('save acked, card is flashing + rebooting.');
      break;

    case 'factory-reset':
      await withDevice(portArg, async (send, recv) => { send(CMD.FACTORY_RESET); expectAck(await recv()); });
      console.log('factory-reset acked.');
      break;

    case 'diag':
      await withDevice(portArg, async (send, recv) => {
        send(CMD.DIAG);
        const p = await recv();
        if (p.cmd !== CMD.DIAG_DUMP) throw new Error(`expected DIAG_DUMP, got 0x${p.cmd.toString(16)}`);
        const v = new DataView(p.payload.buffer, p.payload.byteOffset, p.payload.byteLength);
        const ver = v.getUint8(0);
        const build_hash       = v.getUint32(4, true);
        const snapshot_crc     = v.getUint32(8, true);
        const last_apply_rc    = v.getInt32(12, true);
        const apply_count      = v.getUint32(16, true);
        const apply_attempts   = v.getUint32(20, true);
        const pending_ready    = v.getUint8(24);
        const pending_len      = v.getUint16(26, true);
        const sample_counter   = v.getUint32(28, true);
        const last_apply_sample= v.getUint32(32, true);
        const snapshot_len     = v.getUint16(36, true);
        const core1_done       = v.getUint32(40, true);
        const cycles_avg_total = v.getUint32(44, true);
        const cycles_max_total = v.getUint32(48, true);
        const cycles_avg_walk  = v.getUint32(52, true);
        const cycles_avg_io    = v.getUint32(56, true);
        const sysclk_hz        = v.getUint32(60, true);
        const samples_window   = v.getUint32(64, true);
        const budget_per_sample = sysclk_hz / 48000 | 0;
        const load_pct = budget_per_sample ? (cycles_avg_total / budget_per_sample * 100) : 0;
        console.log(`diag v${ver}:`);
        console.log(`  build_hash=0x${build_hash.toString(16).padStart(8,'0')}`);
        console.log(`  snapshot: crc=0x${snapshot_crc.toString(16).padStart(8,'0')} len=${snapshot_len}B`);
        console.log(`  apply: count=${apply_count} attempts=${apply_attempts} last_rc=${last_apply_rc} last_sample=${last_apply_sample}`);
        console.log(`  pending: ready=${pending_ready} len=${pending_len}B`);
        console.log(`  runtime: sample_counter=${sample_counter} core1_done=${core1_done}`);
        console.log(`  perf (${samples_window} sample window): avg_total=${cycles_avg_total} max=${cycles_max_total} avg_walk=${cycles_avg_walk} avg_io=${cycles_avg_io}`);
        console.log(`  budget: sysclk=${sysclk_hz} per_sample=${budget_per_sample} load=${load_pct.toFixed(1)}%`);
      });
      break;

    case 'perf':
      await withDevice(portArg, async (send, recv) => {
        send(CMD.READ_PERF);
        const p = await recv();
        if (p.cmd !== CMD.PERF_DUMP) throw new Error(`expected PERF_DUMP, got 0x${p.cmd.toString(16)}`);
        // PERF_DUMP payload (see main.cpp ~line 770):
        //   ver u8, sec_count u8, count u16, must u16, stride u16,
        //   sysclk u32, samples u32, block_us u32, core1_loops u32,
        //   total_avg u32, total_max u32, late u32, db_full u32,
        //   walk_avg u32, io_avg u32
        const v = new DataView(p.payload.buffer, p.payload.byteOffset, p.payload.byteLength);
        const count_n   = v.getUint16(2, true);
        const sysclk    = v.getUint32(8, true);
        const samples   = v.getUint32(12, true);
        const block_us  = v.getUint32(16, true);
        const c1_loops  = v.getUint32(20, true);
        const total_avg = v.getUint32(24, true);
        const total_max = v.getUint32(28, true);
        const late      = v.getUint32(32, true);
        const db_full   = v.getUint32(36, true);
        const walk_avg  = v.getUint32(40, true);
        const io_avg    = v.getUint32(44, true);
        const budget    = sysclk / 48000 | 0;
        const load_pct  = budget ? (total_avg / budget * 100) : 0;
        console.log(`perf (${count_n}-sample window, sysclk ${sysclk}):`);
        console.log(`  total avg=${total_avg}/budget=${budget} cycles (${load_pct.toFixed(1)}% load) max=${total_max}`);
        console.log(`  walk avg=${walk_avg}  io avg=${io_avg}  late=${late}  db_full=${db_full}`);
        console.log(`  samples=${samples}  block_us=${block_us}  core1_loops=${c1_loops}`);
      });
      break;

    case 'slot-perf':
      await withDevice(portArg, async (send, recv) => {
        /* Fetch kernel names from the live snapshot. */
        send(CMD.READ_STATE);
        const sd = await recv();
        let kernelByWalkIdx = {};
        if (sd.cmd === CMD.STATE_DUMP) {
          try {
            const { decode } = require('../compiler/snapshot.js');
            const info = decode(sd.payload);
            for (const s of info.sampleRate) kernelByWalkIdx[s.slotId] = s.kernel;
          } catch (_) { /* names unavailable; fall back to slot index */ }
        }

        send(CMD.SLOT_PERF);
        const p = await recv();
        if (p.cmd !== CMD.SLOT_PERF_DUMP) {
          if (p.cmd === CMD.ACK) { console.log('slot-perf not available (LENS_PERF_PROBE=0)'); return; }
          throw new Error(`expected SLOT_PERF_DUMP, got 0x${p.cmd.toString(16)}`);
        }
        const b = p.payload;
        const slotCount = b[0] | (b[1] << 8);
        const rows = [];
        for (let i = 0; i < slotCount; i++) {
          const o = 2 + i * 12;
          const total = readU32LE(b, o + 0);
          const max   = readU32LE(b, o + 4);
          const calls = readU32LE(b, o + 8);
          if (calls === 0) continue;
          const avg = (total / calls) | 0;
          rows.push({ idx: i, kernel: kernelByWalkIdx[i] || `slot_${i}`, calls, avg, max, total });
        }
        rows.sort((a, bv) => bv.total - a.total);
        const top = rows.slice(0, 20);
        const hdr = 'slot  kernel                     calls       avg      max         total';
        console.log(hdr);
        console.log('-'.repeat(hdr.length));
        for (const row of top) {
          const idx  = String(row.idx).padStart(4);
          const name = row.kernel.replace(/^op_/, '').padEnd(24);
          const calls = String(row.calls).padStart(8);
          const avg   = String(row.avg).padStart(8);
          const mx    = String(row.max).padStart(8);
          const tot   = String(row.total).padStart(12);
          console.log(`${idx}  ${name}  ${calls}  ${avg}  ${mx}  ${tot}`);
        }
      });
      break;

    case 'roundtrip': {
      const file = positional[0]; if (!file) throw new Error('usage: roundtrip <patch.loupe>');
      const snapshot = snapshotFromPatch(file);
      await withDevice(portArg, async (send, recv) => {
        await writeState(send, recv, snapshot);
        await new Promise(r => setTimeout(r, 700));
        send(CMD.READ_STATE);
        const p = await recv();
        if (p.cmd !== CMD.STATE_DUMP) throw new Error(`expected STATE_DUMP, got 0x${p.cmd.toString(16)}`);
        const back = Buffer.from(p.payload);
        if (Buffer.compare(Buffer.from(snapshot), back) === 0) console.log(`roundtrip OK, byte-exact (${snapshot.length} B)`);
        else { console.log(`roundtrip MISMATCH (sent ${snapshot.length} B, got ${back.length} B)`); process.exitCode = 1; }
      });
      break;
    }

    case 'watch': {
      const file = positional[0]; if (!file) throw new Error('usage: watch <patch.loupe>');
      await withDevice(portArg, async (send, recv) => {
        await setSwapMode(send, recv);
        let lastBytes = null;
        const push = async () => {
          try {
            const snapshot = snapshotFromPatch(file);
            if (lastBytes && Buffer.compare(Buffer.from(snapshot), Buffer.from(lastBytes)) === 0) return;
            await writeState(send, recv, snapshot);
            lastBytes = snapshot;
            console.log(`${new Date().toLocaleTimeString()}  pushed ${file} (${snapshot.length} B)`);
          } catch (e) { console.error(`${new Date().toLocaleTimeString()}  ${e.message}`); }
        };
        await push();
        console.log('watching (ctrl-c to stop)...');
        let timer = null;
        fs.watch(path.dirname(path.resolve(file)), (_ev, name) => {
          if (name !== path.basename(file)) return;
          clearTimeout(timer); timer = setTimeout(push, 150);
        });
        await new Promise(() => {});
      });
      break;
    }

    case 'test': {
      const sub = positional[0];
      if (!sub || sub === '--help' || sub === 'help') {
        console.log([
          'node cli/cli.js test <subcommand> [--report=<file>] [--port <substr>]',
          '',
          'subcommands:',
          '  ping        quick ACK check (auto)',
          '  phase-a     liveness: factory patch + knob + switch   (listen/observe)',
          '  phase-b     iteration: push bench patches, verify paths  (auto + listen)',
          '  phase-c     calibration: derive cost_profile.json  (auto)',
          '  phase-d     stability + jitter soak  (observe)',
          '  corpus      push every patches/*.loupe, record perf  (auto)',
          '  all         run all phases in order  (mixed)',
          '',
          'options:',
          '  --report=<file>   write JSON report to file (also prints to stdout)',
          '  --port <substr>   MIDI port substring (default: /lens|workshop|music thing/i)',
        ].join('\n'));
        break;
      }
      const reportFlag = rest.find(a => a.startsWith('--report='));
      const reportFile = reportFlag ? reportFlag.slice('--report='.length) : null;
      const { runTestSuite } = require('../attic/tests/test-suite.js');
      await runTestSuite({ sub, portArg, reportFile, REPO, snapshotFromPatch, withDevice, send: null, recv: null, CMD, writeState });
      break;
    }

    case 'diag':
      await withDevice(portArg, async (send, recv) => {
        send(CMD.DIAG);
        const p = await recv();
        if (p.cmd !== CMD.DIAG_DUMP) throw new Error(`expected DIAG_DUMP, got 0x${p.cmd.toString(16)}`);
        console.log(formatDiag(p.payload));
      });
      break;


    case 'record': {
      const secs = parseFloat(positional[0] || '1.0');
      const outWav = positional[1] || `recording-${Date.now()}.wav`;
      const { spawnSync } = require('child_process');
      const r = spawnSync('sox', ['-d', '-r', '48000', '-c', '1', '-b', '16', outWav, 'trim', '0', String(secs)],
                          { stdio: ['ignore', 'inherit', 'inherit'] });
      if (r.status !== 0) throw new Error('sox failed (install with: brew install sox; check audio input is selected)');
      console.log(`recorded ${secs}s to ${outWav}`);
      break;
    }

    case 'verify': {
      const file = positional[0]; if (!file) throw new Error('usage: verify <patch.loupe> [--expect-hz N] [--secs 0.5]');
      const expectHz = flagVal('--expect-hz') ? parseFloat(flagVal('--expect-hz')) : null;
      const secs = parseFloat(flagVal('--secs') || '0.5');
      const snapshot = snapshotFromPatch(file);
      const expectedCrc = crc32(snapshot.slice(0, snapshot.length - 4));
      await withDevice(portArg, async (send, recv) => {
        // 1. snapshot current diag for baseline.
        send(CMD.DIAG); const d0 = parseDiag((await recv()).payload);
        // 2. push patch.
        await writeState(send, recv, snapshot);
        // 3. poll diag until apply_count increments OR snapshot_crc matches.
        const targetCrc = readU32LE(snapshot, snapshot.length - 4);
        let applied = false; let d1 = d0;
        for (let i = 0; i < 50; i++) {
          await new Promise(r => setTimeout(r, 40));
          send(CMD.DIAG); d1 = parseDiag((await recv()).payload);
          if (d1.snapshot_crc === targetCrc && d1.apply_count > d0.apply_count) { applied = true; break; }
          if (d1.apply_attempts > d0.apply_attempts && d1.last_apply_rc !== 0) {
            console.log(formatDiag(arrayFromObj(d1)));
            throw new Error(`snapshot_apply failed with rc=${d1.last_apply_rc}`);
          }
        }
        if (!applied) { console.log(formatDiag(arrayFromObj(d1))); throw new Error('patch did not apply within 2s'); }
        console.log(`applied: crc=0x${d1.snapshot_crc.toString(16).padStart(8, '0')} apply_count=${d1.apply_count}`);
        if (expectHz === null) return;
        // 4. record + analyse pitch.
        const wav = `verify-${Date.now()}.wav`;
        const { spawnSync } = require('child_process');
        const r = spawnSync('sox', ['-d', '-r', '48000', '-c', '1', '-b', '16', wav, 'trim', '0', String(secs)],
                            { stdio: ['ignore', 'inherit', 'inherit'] });
        if (r.status !== 0) throw new Error('sox failed');
        const measured = estimateHzFromWav(wav);
        const cents = 1200 * Math.log2(measured / expectHz);
        const ok = Math.abs(cents) < 50;
        console.log(`expect=${expectHz.toFixed(2)}Hz  measured=${measured.toFixed(2)}Hz  err=${cents.toFixed(1)} cents  ${ok ? 'OK' : 'FAIL'}`);
        if (!ok) process.exitCode = 1;
      });
      break;
    }

    default:
      console.error('commands: ping | diag | write <p> [--save] | save | factory-reset | perf | slot-perf | roundtrip <p> | watch <p> | record <secs> [out.wav] | verify <p> [--expect-hz N] [--secs 0.5] | test [...]');
      process.exit(2);
  }
}

// ---- diag helpers ----
function readU32LE(b, o) { return (b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0; }
function parseDiag(payload) {
  const b = payload;
  // header: ver u8, _pad u8, _pad u16 (4 bytes)
  // identity block: offsets 0-47
  // perf block: offsets 48-71 (zero when LENS_PERF_PROBE=0)
  return {
    ver:                b[0],
    build_hash:         readU32LE(b, 4),
    snapshot_crc:       readU32LE(b, 8),
    last_apply_rc:      (readU32LE(b, 12) | 0),  // sign-extend
    apply_count:        readU32LE(b, 16),
    apply_attempts:     readU32LE(b, 20),
    pending_ready:      b[24],
    pending_len:        b[26] | (b[27] << 8),
    sample_counter:     readU32LE(b, 28),
    last_apply_sample:  readU32LE(b, 32),
    snapshot_len:       b[36] | (b[37] << 8),
    core1_done:         readU32LE(b, 40),
    cycles_avg_total:   readU32LE(b, 44),
    cycles_max_total:   readU32LE(b, 48),
    cycles_avg_walk:    readU32LE(b, 52),
    cycles_avg_io:      readU32LE(b, 56),
    sysclk_hz:          readU32LE(b, 60),
    samples_window:     readU32LE(b, 64),
  };
}
function arrayFromObj(d) { return d; /* identity; formatDiag handles object too */ }
function formatDiag(payloadOrObj) {
  const d = (payloadOrObj && typeof payloadOrObj.byteLength === 'number') ? parseDiag(payloadOrObj) : payloadOrObj;
  const dirty = (d.build_hash & 0x80000000) ? ' (dirty)' : '';
  const hash  = (d.build_hash & 0x7FFFFFFF).toString(16).padStart(8, '0');
  const lines = [
    `build hash:       ${hash}${dirty}`,
    `snapshot crc:     0x${d.snapshot_crc.toString(16).padStart(8, '0')}  (live patch identity)`,
    `snapshot len:     ${d.snapshot_len} B`,
    `apply count:      ${d.apply_count} / ${d.apply_attempts} attempts`,
    `last apply rc:    ${d.last_apply_rc}` + (d.last_apply_rc === 0 ? ' (OK)' : ' (FAILED)'),
    `pending ready:    ${d.pending_ready ? 'YES' : 'no'}  pending_len=${d.pending_len}`,
    `sample counter:   ${d.sample_counter}  (last apply at ${d.last_apply_sample})`,
    `core1_done:       ${d.core1_done}`,
  ];
  if (d.sysclk_hz > 0) {
    const budget      = (d.sysclk_hz / 48000) | 0;
    const loadAvg     = d.cycles_avg_total / budget * 100;
    const loadPeak    = d.cycles_max_total / budget * 100;
    const walkPct     = d.cycles_avg_total > 0 ? d.cycles_avg_walk / d.cycles_avg_total * 100 : 0;
    const ioPct       = d.cycles_avg_total > 0 ? d.cycles_avg_io   / d.cycles_avg_total * 100 : 0;
    const mhz         = (d.sysclk_hz / 1e6).toFixed(1);
    lines.push(
      `cpu load avg:     ${loadAvg.toFixed(1)}%   (~${d.cycles_avg_total} cycles / ${budget} budget per sample)`,
      `cpu load peak:    ${loadPeak.toFixed(1)}%   (~${d.cycles_max_total} cycles)`,
      `walk avg:         ${d.cycles_avg_walk} cycles  (${walkPct.toFixed(1)}%)`,
      `io avg:           ${d.cycles_avg_io} cycles  (${ioPct.toFixed(1)}%)`,
      `sysclk:           ${mhz} MHz`,
      `samples window:   ${d.samples_window}`,
    );
  }
  return lines.join('\n');
}

// CRC32/IEEE: matches snapshot encoder.
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Cheap pitch estimate: read WAV, autocorrelation peak in 50–2000 Hz range.
function estimateHzFromWav(wavPath) {
  const buf = fs.readFileSync(wavPath);
  // find "data" chunk
  let o = 12;
  while (o < buf.length - 8) {
    const id = buf.toString('ascii', o, o + 4);
    const len = buf.readUInt32LE(o + 4);
    if (id === 'data') { o += 8; break; }
    o += 8 + len;
  }
  // Assume 16-bit mono 48k (we wrote it that way).
  const SR = 48000;
  const n = Math.min(SR / 2, (buf.length - o) / 2) | 0;
  const x = new Float32Array(n);
  // skip first 1024 samples to avoid attack transient
  const skip = Math.min(1024, n);
  for (let i = 0; i < n - skip; i++) x[i] = buf.readInt16LE(o + (i + skip) * 2) / 32768;
  // autocorrelation, lag from SR/2000 to SR/50
  const lagMin = Math.floor(SR / 2000), lagMax = Math.floor(SR / 50);
  let bestLag = lagMin, bestR = -1;
  const N = n - skip - lagMax;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let r = 0;
    for (let i = 0; i < N; i++) r += x[i] * x[i + lag];
    if (r > bestR) { bestR = r; bestLag = lag; }
  }
  return SR / bestLag;
}

main().catch(e => { console.error('error: ' + e.message); process.exit(1); });
