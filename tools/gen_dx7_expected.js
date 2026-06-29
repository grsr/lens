'use strict';
// Generate expected dx7_parse_voice output for the C self-test.
// Reads Bank0024.syx, outputs JSON array of {index, cells} objects to stdout.

const fs = require('fs');
const path = require('path');
const { parseBank, voiceCells, parseVoice } = require('./dx7import');

const SYX_PATH = '/Users/graham/Documents/DX7_AllTheWeb/Chris Dodunski/Bank0024.syx';
const VOICE_INDICES = [0, 6, 12, 16, 22, 26, 31];

const buf = fs.readFileSync(SYX_PATH);
// Tolerate F0 wrapper (byte 0 == 0xF0 -> skip 6-byte header).
const body = (buf[0] === 0xF0) ? buf.slice(6, 6 + 4096) : buf;

const results = VOICE_INDICES.map(idx => {
  const raw = body.slice(idx * 128, idx * 128 + 128);
  const voice = parseVoice(raw);
  const cells = voiceCells(voice);
  return { index: idx, cells };
});

process.stdout.write(JSON.stringify(results, null, 2) + '\n');
