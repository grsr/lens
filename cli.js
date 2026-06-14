#!/usr/bin/env node
// cli.js: send Lens patches to the card over USB MIDI SysEx.
//
//   node cli.js ping                       handshake (expects ACK)
//   node cli.js write <patch.loupe> [--save]  compile -> snapshot -> WRITE_STATE (live); --save also persists
//   node cli.js save                        ask the card to flash the live patch + reboot
//   node cli.js factory-reset               erase flash, reboot to the embedded default
//   node cli.js read [--out file.syx]       READ_STATE; print summary, optionally save the .syx
//   node cli.js roundtrip <patch.loupe>     WRITE_STATE then READ_STATE; assert byte-exact
//   node cli.js perf [--watch]              READ_PERF; print the on-card cycle probe (E0)
//   node cli.js watch <patch.loupe>         live-coding loop: re-push on every save
//   node cli.js render <patch.loupe> [out.wav]  render via the host sim (no hardware needed)
//
// Options:  --port <substr>   pick the MIDI port whose name contains <substr>
//                             (default: matches /lens|workshop|music thing/i)
//
// The snapshot format and packing are shared with the firmware (snapshot.h / lens_sysex.cpp)
// and the web UI (compile.js serializeSnapshot, sysex.js).
'use strict';
const fs = require('fs');
const path = require('path');
const { compilePatch, loadPatch, serializeSnapshot, serializePatch } = require('./compile.js');
const { decodeSnapshot } = require('./serialize.js');
const { CMD, frame, parse } = require('./sysex.js');

let midi;
try { midi = require('@julusian/midi'); }
catch { console.error('Missing dependency. Run:  npm install'); process.exit(1); }

const DEFAULT_FILTER = /lens|workshop|music thing/i;

function pickPort(io, want) {
  const n = io.getPortCount();
  const names = [];
  for (let i = 0; i < n; i++) names.push(io.getPortName(i));
  const test = want ? (s => s.toLowerCase().includes(want.toLowerCase())) : (s => DEFAULT_FILTER.test(s));
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
  inp.ignoreTypes(false, true, true);   // CRITICAL: do not ignore SysEx

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

function expectAck(p, cmd) {
  if (p.cmd === CMD.ACK) return;
  if (p.cmd === CMD.NACK) throw new Error(`card NACK (cmd 0x${(p.payload[0]||0).toString(16)}, reason 0x${(p.payload[1]||0).toString(16)})`);
  throw new Error(`unexpected reply 0x${p.cmd.toString(16)}`);
}

function snapshotFromPatch(file) {
  return serializeSnapshot(compilePatch(loadPatch(fs.readFileSync(file, 'utf8'), path.dirname(file))));
}

// WRITE_STATE with retry-on-busy (NACK 0x06 = previous patch not yet applied; back off and resend).
async function writeState(send, recv, snapshot, tries = 4) {
  for (;;) {
    send(CMD.WRITE_STATE, snapshot);
    const p = await recv();
    if (p.cmd === CMD.ACK) return;
    if (p.cmd === CMD.NACK && p.payload[1] === 0x06 && --tries > 0) {
      await new Promise(r => setTimeout(r, 200));
      continue;
    }
    expectAck(p, CMD.WRITE_STATE);   // throws the right error
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const portArg = (() => { const k = rest.indexOf('--port'); return k >= 0 ? rest[k + 1] : undefined; })();
  const hasFlag = f => rest.includes(f);
  const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--port');

  switch (cmd) {
    case 'ping':
      await withDevice(portArg, async (send, recv) => { send(CMD.PING); expectAck(await recv()); console.log('pong (ACK)'); });
      break;

    case 'write': {
      const file = positional[0]; if (!file) throw new Error('usage: write <patch.loupe> [--save]');
      const save = hasFlag('--save');
      const snapshot = snapshotFromPatch(file);
      await withDevice(portArg, async (send, recv) => {
        await writeState(send, recv, snapshot);
        if (save) {
          // Wait for WRITE to apply (next beat) before sending SAVE.
          await new Promise(r => setTimeout(r, 700));
          send(CMD.SAVE_STATE); expectAck(await recv());
        }
      });
      console.log(save ? `wrote + saved ${file} (${snapshot.length} B), card flashing + rebooting.`
                       : `wrote ${file} (${snapshot.length} B snapshot), live (not saved). Use 'save' or --save to persist.`);
      break;
    }

    case 'save':
      await withDevice(portArg, async (send, recv) => { send(CMD.SAVE_STATE); expectAck(await recv()); });
      console.log('save acked, card is flashing + rebooting.');
      break;

    case 'factory-reset':
      await withDevice(portArg, async (send, recv) => { send(CMD.FACTORY_RESET); expectAck(await recv()); });
      console.log('factory-reset acked, card erasing flash + rebooting to default.');
      break;

    case 'read': {
      const k = rest.indexOf('--out'); const outFile = k >= 0 ? rest[k + 1] : null;
      await withDevice(portArg, async (send, recv) => {
        send(CMD.READ_STATE);
        const p = await recv();
        if (p.cmd !== CMD.STATE_DUMP) throw new Error(`expected STATE_DUMP, got 0x${p.cmd.toString(16)}`);
        const ver = p.payload[4] | (p.payload[5] << 8) | (p.payload[6] << 16) | (p.payload[7] << 24);
        console.log(`STATE_DUMP: ${p.payload.length} B, magic ${String.fromCharCode(...p.payload.slice(0,4))}, version 0x${(ver>>>0).toString(16)}`);
        if (outFile) { fs.writeFileSync(outFile, Buffer.from(frame(CMD.WRITE_STATE, p.payload))); console.log(`wrote ${outFile}`); }
      });
      break;
    }

    case 'status': {
      // READ_STATE -> decode -> print card state: knobs, tapes, graph size, terminals.
      await withDevice(portArg, async (send, recv) => {
        send(CMD.READ_STATE);
        const p = await recv();
        if (p.cmd !== CMD.STATE_DUMP) throw new Error(`expected STATE_DUMP, got 0x${p.cmd.toString(16)}`);
        const s = decodeSnapshot(Buffer.from(p.payload));
        console.log(`snapshot ${p.payload.length} B, version 0x${(s.version >>> 0).toString(16)}`);
        console.log(`master: main=${s.master.main} x=${s.master.x} y=${s.master.y}   active page: ${s.active_page}`);
        const elem = (start, i) => { const g = start + (i >> 1) * 3, b = s.control;
          return (i & 1) ? ((b[g + 1] >> 4) | (b[g + 2] << 4)) : (b[g] | ((b[g + 1] & 0x0F) << 8)); };
        s.tapes.forEach((t, i) => console.log(
          `tape-${i}: len=${t.length} start=${t.start} clockDiv=${t.clockDiv} drift=${t.drift}` +
          ` frozen=${t.frozen} stored(main/x/y)=${t.main_stored}/${t.x_stored}/${t.y_stored}` +
          (t.length > 0 && t.length <= 64 && t.clockDiv === 0
            ? `  [${Array.from({ length: t.length }, (_, k) => elem(t.start, k)).join(' ')}]` : '')));
        console.log(`graph: ${s.graph.nodes.length} nodes, ${s.graph.literals.length} literals`);
        const T = s.terminals;
        console.log(`terminals: jacks [${T.jack.join(' ')}]  leds [${T.led.join(' ')}]` +
                    `  reset ${T.reset} clock-in ${T.clock_in}  rec ${T.rec.map(r => r.tape + ':' + r.terminal).join(' ') || '-'}`);
        for (const j of [0, 1]) {
          const t = T.jack[j];
          if (t >= 0) { const n = s.graph.nodes[t];
            console.log(`cv-out-${j + 1} terminal: node ${t} kind=${n.kind} is_signal=${n.is_signal}`); }
        }
      });
      break;
    }

    case 'perf': {
      // READ_PERF -> on-card cycle probe; --watch repolls every second.
      const decodePerf = (b) => {
        let o = 0;
        const u8  = () => b[o++];
        const u16 = () => { const v = b[o] | (b[o + 1] << 8); o += 2; return v; };
        const u32 = () => { const v = (b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0; o += 4; return v; };
        const ver = u8(), nsec = u8();
        const p = { ver, count: u16(), must: u16(), stride: u16(),
                    sysclk: u32(), samples: u32(), block_us: u32(), core1_loops: u32(),
                    sec: [] };
        for (let s = 0; s < nsec; s++) p.sec.push({ avg: u32(), max: u32() });
        p.total_avg = u32(); p.total_max = u32();
        if (ver >= 2) { p.late = u32(); p.db_full = u32(); }
        return p;
      };
      const printPerf = (p) => {
        const names = ['schedule', 'jacks', 'recordheads', 'io'];
        const budget = p.sysclk / 48000;   // cycles per sample
        const us = c => (c / (p.sysclk / 1e6)).toFixed(2);
        const rt = p.block_us > 0 ? (100000 / p.block_us) : 0; // 4800 samples / 100 ms
        console.log(`sysclk ${(p.sysclk / 1e6).toFixed(0)} MHz, budget ${budget.toFixed(0)} cyc/sample` +
                    `   graph: ${p.count} nodes (${p.must} must-run, stride ${p.stride})`);
        console.log(`real-time factor ${rt.toFixed(3)}  (block ${p.block_us} us / 100000)` +
                    `   core1 ${(p.core1_loops * (1e6 / Math.max(p.block_us, 1)) / 1000).toFixed(0)}k loops/s` +
                    (p.late !== undefined ? `   core1 stalls ${p.late}/4800, doorbell full ${p.db_full}` : ''));
        p.sec.forEach((s, i) => console.log(
          `  ${(names[i] || 's' + i).padEnd(12)} avg ${String(s.avg).padStart(5)} cyc (${us(s.avg)} us, ${(100 * s.avg / budget).toFixed(1)}%)` +
          `   max ${String(s.max).padStart(6)} cyc (${us(s.max)} us)`));
        console.log(`  ${'TOTAL'.padEnd(12)} avg ${String(p.total_avg).padStart(5)} cyc (${us(p.total_avg)} us, ${(100 * p.total_avg / budget).toFixed(1)}%)` +
                    `   max ${String(p.total_max).padStart(6)} cyc (${us(p.total_max)} us)`);
      };
      await withDevice(portArg, async (send, recv) => {
        do {
          send(CMD.READ_PERF);
          const p = await recv();
          if (p.cmd !== CMD.PERF_DUMP) throw new Error(`expected PERF_DUMP, got 0x${p.cmd.toString(16)}`);
          printPerf(decodePerf(p.payload));
          if (hasFlag('--watch')) await new Promise(r => setTimeout(r, 1000));
        } while (hasFlag('--watch'));
      });
      break;
    }

    case 'roundtrip': {
      const file = positional[0]; if (!file) throw new Error('usage: roundtrip <patch.loupe>');
      const snapshot = snapshotFromPatch(file);
      await withDevice(portArg, async (send, recv) => {
        await writeState(send, recv, snapshot);
        // Wait for apply (next beat) before reading back.
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
      // Live-coding loop: recompile + push on every save; compile errors print and keep watching.
      const file = positional[0]; if (!file) throw new Error('usage: watch <patch.loupe>');
      await withDevice(portArg, async (send, recv) => {
        const push = async () => {
          try {
            const snapshot = snapshotFromPatch(file);
            await writeState(send, recv, snapshot);
            console.log(`${new Date().toLocaleTimeString()}  pushed ${file} (${snapshot.length} B)`);
          } catch (e) { console.error(`${new Date().toLocaleTimeString()}  ${e.message}`); }
        };
        await push();
        console.log('watching (ctrl-c to stop)...');
        let timer = null;   // directory watch: editors save via rename, killing a direct file watch
        fs.watch(path.dirname(path.resolve(file)), (_ev, name) => {
          if (name !== path.basename(file)) return;
          clearTimeout(timer); timer = setTimeout(push, 150);
        });
        await new Promise(() => {});
      });
      break;
    }

    case 'render': {
      const file = positional[0]; if (!file) throw new Error('usage: render <patch.loupe> [out.wav]');
      const outWav = positional[1] || file.replace(/\.loupe$/, '') + '.wav';
      const sim = path.join(__dirname, 'lens_run');
      if (!fs.existsSync(sim))
        throw new Error('host sim not built. Run: clang++ -std=c++17 -I. run.cpp -o ./lens_run');
      const text = serializePatch(compilePatch(loadPatch(fs.readFileSync(file, 'utf8'), path.dirname(file))));
      const r = require('child_process').spawnSync(sim, [outWav], { input: text });
      if (r.status !== 0) throw new Error('sim failed: ' + (r.stderr || ''));
      console.log(`rendered ${outWav} (+ lens_sim_events.csv)`);
      break;
    }

    default:
      console.error('commands: ping | write <p> [--save] | save | factory-reset | read [--out f] | roundtrip <p> | watch <p> | render <p> [out.wav]   [--port <substr>]');
      process.exit(2);
  }
}

main().catch(e => { console.error('error: ' + e.message); process.exit(1); });
