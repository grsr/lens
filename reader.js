// reader.js: text -> nested arrays (s-expression reader).
'use strict';

const ARROW_ALIAS = { "→": "->", "←": "<-", "↑": "input", "↓": "output" };

function tokenize(s) {
  const t = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === ';') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '(' || c === ')' || c === "'") { t.push(c); i++; continue; }
    let j = i; while (j < s.length && !" \t\n\r()'".includes(s[j])) j++;
    const tok = s.slice(i, j); t.push(ARROW_ALIAS[tok] || tok); i = j;
  }
  return t;
}

function read(toks) {
  if (!toks.length) throw new Error("unexpected end of input");
  const t = toks.shift();
  if (t === "'") return ["quote", read(toks)];
  if (t === '(') {
    const list = [];
    while (toks[0] !== ')') {
      if (!toks.length) throw new Error("missing )");
      list.push(read(toks));
    }
    toks.shift();
    return list;
  }
  if (t === ')') throw new Error("unexpected )");
  return t;
}

// Note name (C4 / Eb5 / F#2) -> MIDI note 0..127, or null.
const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function parseNoteName(s) {
  const m = /^([A-G])([#sb]*)(-?\d+)$/.exec(s);
  if (!m) return null;
  let n = (parseInt(m[3], 10) + 1) * 12 + NOTE_PC[m[1]];
  for (const c of m[2]) n += (c === 'b') ? -1 : 1;
  return n < 0 ? 0 : n > 127 ? 127 : n;
}
function noteValue(s) {
  const v = parseNoteName(String(s)); if (v !== null) return v;
  const n = parseInt(s, 10); return Number.isNaN(n) ? null : n;
}

module.exports = { tokenize, read, parseNoteName, noteValue };
