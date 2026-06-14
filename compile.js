#!/usr/bin/env node
// compile.js: Loupe text (patch S-expression) -> binary snapshot (snapshot.h format).
// One code path: text -> compilePatch -> serializeSnapshot -> wire/flash/boot bytes.
// Values between forms are 12-bit at rest; the jack/head decides what a value means.

'use strict';

const { tokenize, read, parseNoteName, noteValue } = require('./reader.js');
const { VMAX, EVERY_SAMPLE, EVERY_BEAT, EVERY_CTRL, NEVER,
        NODES, KIND_ORDER, KIND_ENUM, SIGNAL_KINDS, NODE_INTERVAL,
        KNODEPOOL, KMAXGRAPHLITERALS, BUFFER_BYTES, CONTROL_BYTES } = require("./nodes.js");
const { computeIntervals, finalize, wirePeriod, periodLabel } = require('./intervals.js');
const { serializeSnapshot, SAVE_VERSION } = require('./serialize.js');

// Built-in scale degrees (semitone offsets). Baked into the literal pool at compile time.
const SCALES = {
  "minor":      [0, 2, 3, 5, 7, 8, 10],
  "major":      [0, 2, 4, 5, 7, 9, 11],
  "minor-pent": [0, 3, 5, 7, 10],
  "major-pent": [0, 2, 4, 7, 9],
  "dorian":     [0, 2, 3, 5, 7, 9, 10],
  "phrygian":   [0, 1, 3, 5, 7, 8, 10],
  "lydian":     [0, 2, 4, 6, 7, 9, 11],
  "mixolydian": [0, 2, 4, 5, 7, 9, 10],
  "chromatic":  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
// Built-in named rhythms (x = hit, . = rest). Each becomes a prelude `(def NAME (beat ...))`.
const RHYTHMS = {
  "four-on-floor": "x...x...x...x...",
  "backbeat":      "....x.......x...",
  "eighths":       "x.x.x.x.x.x.x.x.",
  "offbeat":       "..x...x...x...x.",
  "sixteenths":    "xxxxxxxxxxxxxxxx",
  "downbeat":      "x...............",
  "tresillo":      "x..x..x.",
  "cinquillo":     "x.xx.xx.",
  "habanera":      "x..xx...",
  "son-clave":     "x..x..x...x.x...",
  "rumba-clave":   "x..x...x..x.x...",
  "bossa":         "x..x..x...x..x..",
};

// Parse a step pattern into onset values. Accepts a step-string (x/X = hit; . - _ = rest; | space = separators) or (euclid P S).
function beatValues(args) {
  if (args.length === 1 && Array.isArray(args[0]) && args[0][0] === "euclid") {
    const P = parseInt(args[0][1], 10), S = parseInt(args[0][2], 10);
    if (!(P >= 0 && S > 0)) throw new Error("(beat (euclid P S)): need P >= 0 and S > 0");
    const v = []; for (let i = 0; i < S; i++) v.push(((i * P) % S) < P ? VMAX : 0); return v;
  }
  const s = args.map(x => { if (Array.isArray(x)) throw new Error("(beat ...): want a step pattern like x..x.. , got a list"); return String(x); }).join("");
  const v = [];
  for (const ch of s) {
    if      (ch === "x" || ch === "X")              v.push(VMAX);
    else if (ch === "." || ch === "-" || ch === "_") v.push(0);
    else if (ch === "|" || ch === " ")               continue;
    else throw new Error("(beat ...): bad step char '" + ch + "' (use x . - _ | )");
  }
  if (!v.length) throw new Error("(beat ...): empty pattern");
  return v;
}

const JACKS = { cv_out_1: 0, cv_out_2: 1, audio_out_1: 2, audio_out_2: 3, pulse_out_1: 4, pulse_out_2: 5 };
const LEDS  = { led_0: 0, led_1: 1, led_2: 2, led_3: 3, led_4: 4, led_5: 5 };
const ROOT_NOTE   = 60;   // C4
const DEFAULT_OCT = 2;
const LITERAL_BASE = 32;  // must match tape.h kLiteralBase
const POOL_START   = 512; // must match tape.h kPoolStart. Sequence tapes [0,512); literal pool [512,CONTROL_BYTES).
// Standard prelude: shadowable defs for vmax/vmid/vmin, master, hardware names, scales, rhythms.
// Knobs are detented at 0 / midpoint / vmax (within +-96) so full-CCW/noon/full-CW
// snap past ADC LSB jitter (which otherwise drifts patches like the Turing machine
// past chance thresholds even with the pot stationary). `detent` is a PURE chain so
// it inherits the knob's EVERY_CTRL rate; no extra audio-rate cost. `knob-*-raw`
// gives the raw pot for cases that want instant gate-style response.
const HARDWARE = `(def knob-main-raw (knob :main)) (def knob-x-raw (knob :x)) (def knob-y-raw (knob :y))
(def knob-main (detent knob-main-raw 0 2048 4095))
(def knob-x    (detent knob-x-raw    0 2048 4095))
(def knob-y    (detent knob-y-raw    0 2048 4095))
; CV inputs come in two flavours; pick the one that matches your intent.
;   cv-uni-N : raw 0..vmax. Unpatched reads vmid (the midpoint), so this is what
;              you want when the CV is a positive control like a level or a tape index.
;   cv-bi-N  : bipolar around 0 (-vmid..+vmid). Unpatched reads 0, so this is what
;              you want when you're SUMMING the CV onto a knob as modulation.
(def cv-uni-1 (cv-in 1)) (def cv-uni-2 (cv-in 2))
(def cv-bi-1  (sub (cv-in 1) vmid)) (def cv-bi-2 (sub (cv-in 2) vmid))
(def audio-in-1 (audio-in 1)) (def audio-in-2 (audio-in 2))
(def pulse-in-1 (pulse-in 1)) (def pulse-in-2 (pulse-in 2))
(def switch-z (outputs (pos (switch-pos)) (up (eq (switch-pos) 2)) (middle (eq (switch-pos) 1)) (down (eq (switch-pos) 0)))) `;
const STDLIB = `(def vmax 4095) (def vmid 2048) (def vmin 0) (def master (clock :bpm 120))
(def bipolar (fn (:x) (mul x 4095 :bipolar)))
(def unipolar (fn (:s) (add s 2048)))
(def dist (fn (:a :b) (add (sub a b :sat) (sub b a :sat))))
(def sin0 (fn (:x) (bipolar (lookup (curve sine 256) (spread x 256)))))
(def cos0 (fn (:x) (sin0 (add x 1024)))) `
  + HARDWARE
  + Object.entries(SCALES).map(([n, d]) => `(def ${n} (lens '(${d.join(" ")})))`).join(" ")
  // 12-bit pitch-class masks per scale: (snap x :mask (thru scale-masks k)) selects at runtime
  + ` (def scale-masks (lens '(${Object.values(SCALES).map(d => d.reduce((m, x) => m | (1 << (x % 12)), 0)).join(" ")})))`
  + " " + Object.entries(RHYTHMS).map(([n, p]) => `(def ${n} (beat ${p}))`).join(" ");
let STDLIB_NAMES = new Set();   // prelude names (shadowable)
function baseEnv() { const env = new Map(); parsePrelude(STDLIB, env); STDLIB_NAMES = new Set(env.keys()); return env; }
// Hz -> one-pole cutoff value (0..VMAX).
const hzToCutoff = (hz) => Math.max(0, Math.min(VMAX, Math.round(hz * 4096 * 2 * Math.PI / 48000)));

// Packed 12-bit storage (must be bit-identical to ReadElem/WriteElem in tape.h).
const packedBytes = (n) => ((n + 1) >> 1) * 3;
function writeElem(buf, startByte, i, v) {
  v &= 0xFFF;
  const g = startByte + (i >> 1) * 3, a1 = g + 1;
  if ((i & 1) === 0) { buf[g] = v & 0xFF; buf[a1] = (buf[a1] & 0xF0) | ((v >> 8) & 0x0F); }
  else { buf[a1] = (buf[a1] & 0x0F) | ((v & 0x0F) << 4); buf[g + 2] = (v >> 4) & 0xFF; }
}

const tapeIdx = (s) => { const m = /^tape-(\d+)$/.exec(s); return m ? +m[1] : -1; };
const asForm = (src) => (typeof src === "string") ? read(tokenize(src)) : src;
// (audio :seconds S | :length N | :rate R | BARE-SECONDS) -> a sample-tape descriptor.
function parseAudioArgs(list, ctx) {
  const o = { audio: true };
  for (let k = 0; k < list.length; k++) {
    if      (list[k] === ":seconds") o.seconds = Number(list[++k]);
    else if (list[k] === ":rate")    o.rate    = Number(list[++k]);
    else if (list[k] === ":length")  o.length  = Number(list[++k]);
    else if (typeof list[k] === "string" && list[k][0] !== ":") o.seconds = Number(list[k]);
    else throw new Error("(audio ...) takes :seconds/:length/:rate: " + ctx);
  }
  return o;
}

// `def` is the only binder. A value binding names one shared tree (compiled once).
// A function `(def name (fn ...))` instantiates a fresh body per call.
function cloneTree(t) { return Array.isArray(t) ? t.map(cloneTree) : t; }
// Parse an `fn` signature: (:in :opt default ... => :out ...). Returns { params, outputs }.
function parseSignature(sig) {
  if (!Array.isArray(sig)) throw new Error("fn signature must be a list (:in ... => :out ...), got " + JSON.stringify(sig));
  const arrow = sig.indexOf("=>");
  const ins  = arrow >= 0 ? sig.slice(0, arrow) : sig;
  const outs = arrow >= 0 ? sig.slice(arrow + 1) : [];
  const params = []; let seenOpt = false;
  for (let i = 0; i < ins.length; i++) {
    const tok = ins[i];
    if (typeof tok !== "string" || tok[0] !== ":")
      throw new Error("fn param must be :name, got " + JSON.stringify(tok));
    const name = tok.slice(1);
    const nxt = ins[i + 1];
    if (nxt !== undefined && !(typeof nxt === "string" && nxt[0] === ":")) {   // flat default
      params.push({ name, def: nxt }); seenOpt = true; i++;
    } else {
      if (seenOpt) throw new Error("required param :" + name + " must come before optional params");
      params.push({ name });
    }
  }
  const outputs = outs.map(o => {
    if (typeof o !== "string" || o[0] !== ":") throw new Error("fn output must be :name, got " + JSON.stringify(o));
    return o.slice(1);
  });
  return { params, outputs };
}
// {__ports} = multi-output instance; asTree resolves to the default port.
function asTree(v) { return (v && v.__ports) ? v.outs[v.def] : v; }
// Built-in multi-output forms (first port is the default).
const PORTS = { vcf: ["lp", "hp", "bp", "notch"] };
const MAX_EXPAND_DEPTH = 4096;

function expandTree(tree, env, depth = 0) {
  if (depth > MAX_EXPAND_DEPTH) throw new Error("macro expansion too deep (recursive define?)");
  if (typeof tree === "string") {
    if (!env.has(tree)) return tree;
    const v = env.get(tree);
    if (v && v.__fn) throw new Error("function '" + tree + "' used as a value; call it as (" + tree + " ...)");
    return v;   // share-once: same object for every reference
  }
  if (!Array.isArray(tree)) return tree;
  if (tree[0] === "quote") return cloneTree(tree);
  if (tree[0] === "lens")  return cloneTree(tree);   // vocab: resolved by consumer (thru/map)
  if (tree[0] === "fn") {                             // (fn (:in :opt d => :out ...) body...)
    const { params, outputs } = parseSignature(tree[1]);
    const body = tree.slice(2);
    // Single-output: body is ONE expression. Multi-output: body is def/<- statements run by expandBody.
    if (outputs.length === 0 && body.length !== 1)
      throw new Error("a single-output fn body must be one expression; name outputs with => for multiple");
    return { __fn: true, params, outputs, body: outputs.length === 0 ? body[0] : body, env: new Map(env) };
  }
  if (tree[0] === "def") throw new Error("def is a binder, only valid at top level or as a body statement, not inside an expression");
  if (tree[0] === "<-")  throw new Error("<- is a connection statement, only valid at top level or as a body statement, not inside an expression");
  if (tree[0] === "feedback") {
    if (typeof tree[1] === "string")                                   // (feedback name body)
      return ["feedback", tree[1], ...tree.slice(2).map(x => asTree(expandTree(x, env, depth + 1)))];
    if (Array.isArray(tree[1]))                                        // (feedback ((a ..) (b ..)) out)
      return ["feedback",
              tree[1].map(b => [b[0], asTree(expandTree(b[1], env, depth + 1))]),
              ...tree.slice(2).map(x => asTree(expandTree(x, env, depth + 1)))];
  }
  if (tree[0] === "morph") return expandTree(morphTree(tree.slice(1)), env, depth + 1);
  // (onsets rhythm-tape [clock]): VMAX trigger on each new note (onset=VMAX/hold=VMID/rest=0 tape).
  if (tree[0] === "onsets" && (tree.length === 2 || tree.length === 3)) {
    const rt = tree[1], clk = (tree.length === 3) ? tree[2] : "master";
    return expandTree(["and", ["tick", clk], ["gt", ["step", rt, ":clk", clk], "vmid"]], env, depth + 1);
  }
  // (gates rhythm [clock] [:gap G]): gate high on onset+hold, dips low for G ticks at each onset (:gap 0 disables).
  if (tree[0] === "gates") {
    const a = tree.slice(1);
    let gap = "205"; const rest = [];
    for (let k = 0; k < a.length; k++) { if (a[k] === ":gap") gap = a[++k]; else rest.push(a[k]); }
    if (rest.length < 1 || rest.length > 2) throw new Error("(gates rhythm [clock] [:gap G])");
    const rt = rest[0], clk = rest[1] !== undefined ? rest[1] : "master";
    const stepR = ["step", rt, ":clk", clk];
    return expandTree(
      ["and", ["gt", stepR, "vmin"],
              ["not", ["and", ["gt", stepR, "vmid"], ["lt", clk, gap]]]], env, depth + 1);
  }
  // (hits PATTERN [clock]): trigger stream from a step-string, named rhythm, or (euclid P S).
  if (tree[0] === "hits") {
    if (tree.length < 2 || tree.length > 3) throw new Error("(hits PATTERN [clock])");
    const pat = tree[1], clk = (tree.length === 3) ? tree[2] : "master";
    const rt = (Array.isArray(pat) && pat[0] === "euclid") ? ["beat", pat] : pat;
    return expandTree(["onsets", rt, clk], env, depth + 1);
  }
  // (groove [:tempo N|:bpm B|:clk c] (VOICE pattern :params...) ...): drum kit on one clock.
  if (tree[0] === "groove") {
    const a = tree.slice(1);
    let clk = null, clockArgs = null; const voices = [];
    for (let k = 0; k < a.length; k++) {
      if      (a[k] === ":tempo") clockArgs = [":tempo", a[++k]];
      else if (a[k] === ":bpm")   clockArgs = [":bpm", a[++k]];
      else if (a[k] === ":clk")   clk = a[++k];
      else if (Array.isArray(a[k])) voices.push(a[k]);
      else throw new Error("(groove ...): unexpected " + unparse(a[k]) + " (want :tempo/:bpm/:clk or a (voice pattern ...) line)");
    }
    if (!voices.length) throw new Error("(groove ...) needs at least one (voice pattern :params...) line");
    const clock = clk !== null ? clk : ["clock", ...(clockArgs || [":tempo", "2400"])];
    const voiceTrees = voices.map(v => {
      const name = v[0]; let rest = v.slice(1), pat;
      const oi = rest.indexOf(":on");
      if (oi >= 0) { pat = rest[oi + 1]; rest = rest.slice(0, oi).concat(rest.slice(oi + 2)); }
      else { pat = rest[0]; rest = rest.slice(1); }
      if (pat === undefined) throw new Error("(groove): voice '" + name + "' needs a pattern (positional or :on)");
      const rt = (Array.isArray(pat) && pat[0] === "euclid") ? ["beat", pat] : pat;
      return [name, ...rest, ":trig", ["onsets", rt, clock]];
    });
    return expandTree(voiceTrees.length === 1 ? voiceTrees[0] : ["mix", ...voiceTrees], env, depth + 1);
  }
  if (tree[0] === "knob" && tree.indexOf(":detents") >= 0) {
    const di = tree.indexOf(":detents");
    const pts = tree[di + 1];
    if (!Array.isArray(pts)) throw new Error("(knob ... :detents (p0 p1 ...)) needs a list of detent points");
    const knob = [...tree.slice(0, di), ...tree.slice(di + 2)];
    return expandTree(["detent", knob, ...pts], env, depth + 1);
  }
  // (normal IN FALLBACK): use input jack if cabled, else FALLBACK. Sugar over (if (connected ...) IN FB).
  if (tree[0] === "normal") {
    if (tree.length !== 3) throw new Error("(normal IN FALLBACK) takes an input jack and a fallback value");
    const inExp = asTree(expandTree(tree[1], env, depth + 1));
    if (!(Array.isArray(inExp) && (inExp[0] === "cv-in" || inExp[0] === "audio-in" || inExp[0] === "pulse-in")))
      throw new Error("(normal IN FB): IN must be an input jack (cv-in-1, audio-in-2, pulse-in-1, ...)");
    return expandTree(["if", ["connected", inExp[0], inExp[1]], inExp, tree[2]], env, depth + 1);
  }
  // (outputs (name expr) ...): multi-output module; first port is the default.
  if (tree[0] === "outputs") {
    const outs = {}; let def = null;
    for (const o of tree.slice(1)) {
      if (!Array.isArray(o) || typeof o[0] !== "string" || o.length !== 2)
        throw new Error("outputs entry must be (name expr), got " + JSON.stringify(o));
      if (o[0] in outs) throw new Error("duplicate output '" + o[0] + "'");
      outs[o[0]] = asTree(expandTree(o[1], env, depth + 1));
      if (def === null) def = o[0];
    }
    if (def === null) throw new Error("(outputs ...) needs at least one (name expr)");
    return { __ports: true, outs, def };
  }
  if (typeof tree[0] === "string" && env.has(tree[0]) && env.get(tree[0]).__ports) {
    const inst = env.get(tree[0]), nm = tree[0];
    if (tree.length === 1) return inst.outs[inst.def];
    if (tree.length === 2 && typeof tree[1] === "string" && tree[1][0] === ":") {
      const port = tree[1].slice(1);
      if (!(port in inst.outs)) throw new Error("'" + nm + "' has no output :" + port +
        " (has: " + Object.keys(inst.outs).join(", ") + ")");
      return inst.outs[port];
    }
    throw new Error("bad output tap " + JSON.stringify(tree) + " (use (" + nm + " :port))");
  }
  // inline tap: ((expr) :port) without binding; def-bind to share one instance.
  if (Array.isArray(tree[0]) &&
      (tree.length === 1 || (tree.length === 2 && typeof tree[1] === "string" && tree[1][0] === ":"))) {
    const inst = expandTree(tree[0], env, depth + 1);
    if (inst && inst.__ports) {
      if (tree.length === 1) return inst.outs[inst.def];
      const port = tree[1].slice(1);
      if (!(port in inst.outs)) throw new Error("inline tap has no output :" + port +
        " (has: " + Object.keys(inst.outs).join(", ") + ")");
      return inst.outs[port];
    }
  }
  if (typeof tree[0] === "string" && env.has(tree[0]) && env.get(tree[0]).__fn)
    return expandCall(tree, env, depth);
  const pair = expandStereo(tree, env, depth);
  if (pair !== null) return pair;
  // built-in multi-output (e.g. vcf): without a band keyword return {__ports}; with one, fall through.
  if (typeof tree[0] === "string" && PORTS[tree[0]]) {
    const kind = tree[0], outs = PORTS[kind];
    const banded = tree.slice(1).some(a => typeof a === "string" && a[0] === ":" && outs.includes(a.slice(1)));
    if (!banded) {
      const args = tree.slice(1).map(x => asTree(expandTree(x, env, depth + 1)));
      const map = {};
      for (const o of outs) map[o] = [kind, ...args, ":" + o];
      return { __ports: true, outs: map, def: outs[0] };
    }
  }
  return [tree[0], ...tree.slice(1).map(x => asTree(expandTree(x, env, depth + 1)))];
}
// Expand a function call: params filled positionally or by name; defaults eval in definition scope.
function expandCall(tree, env, depth) {
  const fn = env.get(tree[0]), fname = tree[0];
  const fenv = new Map(fn.env), provided = new Map(), rest = tree.slice(1);
  let pos = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a === "string" && a[0] === ":") {
      const nm = a.slice(1);
      if (!fn.params.some(p => p.name === nm)) throw new Error("'" + fname + "' has no input :" + nm);
      // Keep multi-output instances unwrapped so the body can tap ports; use-sites collapse later.
      provided.set(nm, expandTree(rest[++i], env, depth + 1));
    } else {
      if (pos >= fn.params.length) throw new Error("'" + fname + "' takes " + fn.params.length + " input(s), got more");
      provided.set(fn.params[pos++].name, expandTree(a, env, depth + 1));
    }
  }
  for (const p of fn.params) {
    if (provided.has(p.name)) fenv.set(p.name, provided.get(p.name));
    else if (p.def !== undefined) fenv.set(p.name, asTree(expandTree(p.def, fn.env, depth + 1)));
    else throw new Error("'" + fname + "' missing input '" + p.name + "'");
  }
  if (fn.outputs.length === 0) return expandTree(fn.body, fenv, depth + 1);
  return expandBody(fn.body, fenv, fn.outputs, fname, depth + 1);
}
// Run a multi-output fn body (def/← statements). ← PORT fills an output; ← TAPE rebinds to (record ...)
// so later reads carry the write head (delay/chorus/turing as a function). Returns {__ports}.
function expandBody(statements, env, outputs, fname, depth) {
  const env2 = new Map(env), outs = {};
  const isTape = (v) => Array.isArray(v) && (v[0] === "tape" || v[0] === "audio" || v[0] === "record");
  for (const st of statements) {
    if (!Array.isArray(st) || typeof st[0] !== "string")
      throw new Error("'" + fname + "' body: each line is (def name ...) or (<- sink ...), got " + unparse(st));
    if (st[0] === "def") { bindDef(st, env2, depth); continue; }
    if (st[0] === "<-") {
      const { sink, source, clock } = readConnect(st);
      const src = asTree(expandTree(source, env2, depth + 1));
      if (outputs.includes(sink)) {
        if (clock !== undefined) throw new Error("'" + fname + "' output :" + sink + " is not a tape; :clk rides a tape write");
        if (sink in outs) throw new Error("'" + fname + "' output :" + sink + " is wired more than once");
        outs[sink] = src; continue;
      }
      if (typeof sink === "string" && isTape(env2.get(sink))) {
        const tape = env2.get(sink);
        if (tape[0] === "record") throw new Error("'" + fname + "': tape '" + sink + "' already has a writer (one head per tape)");
        const rec = ["record", tape, src];
        if (clock !== undefined) rec.push(":clk", asTree(expandTree(clock, env2, depth + 1)));
        env2.set(sink, rec); continue;
      }
      throw new Error("'" + fname + "' <- " + unparse(sink) + ": not a declared output (" + outputs.join(", ")
                    + ") nor a local tape; a fn body <- fills an output or writes a local (tape ...)/(audio ...)");
    }
    throw new Error("'" + fname + "' body: unexpected '" + st[0] + "' (a body is def + <- statements)");
  }
  for (const o of outputs) if (!(o in outs)) throw new Error("'" + fname + "' output :" + o + " is declared but never wired");
  return { __ports: true, outs, def: outputs[0] };
}
// Stereo bus sugar: channel/stereo-bus/width/rotate all produce a {l r} pair. Returns null otherwise.
function expandStereo(tree, env, depth) {
  const isPair = (v) => v && v.__ports && v.outs.l !== undefined && v.outs.r !== undefined;
  const X = (t) => asTree(expandTree(t, env, depth + 1));        // expand a constructed tree
  const mkPair = (l, r) => ({ __ports: true, outs: { l: X(l), r: X(r) }, def: "l" });
  if (tree[0] === "channel") {
    // (channel v [:pan p] [:level l]): mono -> {l r}. pan: 0=hard-left, vmid=centre, vmax=hard-right.
    let pan = null, lev = null, v = null;
    for (let k = 1; k < tree.length; k++) {
      if      (tree[k] === ":pan")   pan = expandTree(tree[++k], env, depth + 1);
      else if (tree[k] === ":level") lev = expandTree(tree[++k], env, depth + 1);
      else if (v === null) v = asTree(expandTree(tree[k], env, depth + 1));
    }
    if (v === null) throw new Error("(channel v [:pan p] [:level l]) needs a voice");
    if (lev !== null) v = ["vca", v, lev];
    if (pan === null) pan = "2048";
    const q = ["div", pan, "4"];
    return mkPair(["vca", v, ["sin0", ["add", q, "1024"]]],
                  ["vca", v, ["sin0", q]]);
  }
  if (tree[0] === "stereo-bus") {
    // (stereo-bus ch ...): sum channels. A bare mono arg is centred.
    const chs = tree.slice(1).map(x => { const e = expandTree(x, env, depth + 1);
      return isPair(e) ? e : asTree(expandTree(["channel", x], env, depth + 1)); });
    if (!chs.length) throw new Error("(stereo-bus ...) needs at least one channel");
    const fold = (side) => chs.map(c => c.outs[side]).reduce((a, b) => ["mix", a, b]);
    return mkPair(fold("l"), fold("r"));
  }
  if (tree[0] === "width") {
    // (width PAIR amt): mid/side scale; 0 = mono, vmax = full width.
    const p = expandTree(tree[1], env, depth + 1);
    if (!isPair(p)) throw new Error("(width PAIR amt): the first argument must be a stereo pair");
    const amt = expandTree(tree[2], env, depth + 1);
    const mid = ["vca", ["add", p.outs.l, p.outs.r], "2048"], side = ["vca", ["sub", p.outs.l, p.outs.r], "2048"];
    return mkPair(["add", mid, ["vca", side, amt]], ["sub", mid, ["vca", side, amt]]);
  }
  if (tree[0] === "rotate") {
    // (rotate a b theta) or (rotate PAIR theta): 2×2 rotation; theta 0..vmax = full turn.
    const first = expandTree(tree[1], env, depth + 1);
    const pair = isPair(first);
    const a = pair ? first.outs.l : asTree(first);
    const b = pair ? first.outs.r : asTree(expandTree(tree[2], env, depth + 1));
    const th = expandTree(tree[pair ? 2 : 3], env, depth + 1);
    const c = ["cos0", th], s = ["sin0", th];
    return mkPair(["sub", ["vca", a, c], ["vca", b, s]],
                  ["add", ["vca", a, s], ["vca", b, c]]);
  }
  return null;
}
// Bind (def NAME thing): errors on duplicate names (only prelude names may be shadowed).
function bindDef(node, env, depth = 0) {
  if (!Array.isArray(node) || node[0] !== "def" || node.length !== 3 || typeof node[1] !== "string")
    throw new Error("a binding is (def NAME thing): " + unparse(node));
  const name = node[1];
  if (env.has(name) && !STDLIB_NAMES.has(name))
    throw new Error("'" + name + "' is already defined, pick another name (only standard-prelude names like master or minor may be redefined)");
  const v = expandTree(node[2], env, depth);
  if (Array.isArray(v) && v[0] === "lens") validateLens(v, env);   // a lens: check species + refs NOW
  env.set(name, v);
}
function parsePrelude(src, env) {
  const toks = tokenize(src);
  while (toks.length) bindDef(read(toks), env);
}

// Literal pool: greedy first-come allocation in [POOL_START, CONTROL_BYTES).
// Referenced by array_idx = LITERAL_BASE + n.
class Pool {
  constructor(buffer, start = POOL_START, limit = CONTROL_BYTES) { this.buffer = buffer; this.next = start; this.limit = limit; this.dedup = new Map(); }
  alloc(values) {
    const start = this.next, span = packedBytes(values.length);
    if (start + span > this.limit)
      throw new Error("literal pool exhausted (" + span + " bytes, " +
                      (this.limit - start) + " free)");
    for (let k = 0; k < values.length; k++) writeElem(this.buffer, start, k, values[k] & 0xFFF);
    this.next += span;
    return { start, length: values.length };
  }
}

// NO_CSE: structural CSE must not merge stateful (feedback/z1) or impure (random/noise/walk/chance) nodes.
// Named bindings still share via identity memo; only distinct textual occurrences stay separate.
const NO_CSE = new Set(["feedback", "z1", "random", "noise", "walk", "chance"]);

// Named positional params for built-ins: allows (vcf :in x :cut c :res r) == (vcf x c r).
const POS_PARAMS = {
  vcf: ["in", "cut", "res"], average: ["in", "cut"], lpf: ["in", "cut"], hpf: ["in", "cut"], bpf: ["in", "cut"],
  lpg: ["in", "ctrl"], wavefold: ["in", "drive"], crush: ["in", "rate"],
  sine: ["pitch"], triangle: ["pitch"], saw: ["pitch"], square: ["pitch"], phasor: ["pitch"],
  vca: ["in", "amp"], ring: ["in", "amp"],
  slew: ["in", "rate"], envelope: ["amp"], hold: ["value", "trig"], schmitt: ["in", "lo", "hi"],
  step: ["tape"], seek: ["tape", "index"], tap: ["tape", "amount"], wave: ["tape", "pitch"], lookup: ["tape", "index"],
  snap: ["note", "scale"], quantise: ["note", "scale"], pitch: ["in", "scale", "octaves"], degree: ["in", "scale", "octaves"],
  "v-oct": ["note"], cv: ["in"], transpose: ["in", "by"], mask: ["in", "mask"], bit: ["in", "n"], shift: ["in", "by"],
  gate: ["in"], trig: ["in"], counter: ["bars"], chance: ["p"], euclid: ["pulses", "steps"], every: ["n"],
};
// Reorder named positionals into their slots; keyword flags trail untouched. No named args -> unchanged.
function reorderArgs(head, args, names) {
  const named = new Map(), rest = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (typeof t === "string" && t[0] === ":" && names.includes(t.slice(1))) { named.set(t.slice(1), args[++i]); }
    else rest.push(t);
  }
  if (named.size === 0) return args;
  let li = 0; const lead = [];
  while (li < rest.length && !(typeof rest[li] === "string" && rest[li][0] === ":")) lead.push(rest[li++]);
  const trailing = rest.slice(li);
  const slots = []; let take = 0;
  for (const p of names) slots.push(named.has(p) ? named.get(p) : (take < lead.length ? lead[take++] : undefined));
  while (slots.length && slots[slots.length - 1] === undefined) slots.pop();
  if (slots.includes(undefined))
    throw new Error("(" + head + " ...): a named param leaves an earlier positional unfilled; name or supply it too");
  return [...slots, ...lead.slice(take), ...trailing];
}

class Compiler {
  constructor(tapeLengths = {}, pool = null, tapeClockDivs = {}) {
    this.nodes = []; this.types = []; this.memo = new Map(); this.shared = new Map(); this.tapeLengths = tapeLengths;
    this.tapeClockDivs = tapeClockDivs;   // idx -> clock_div (>0 = sample tape)
    this.sweepClocks = {};                // idx -> per-sample sweep phasor for audio tapes
    this.pool = pool || new Pool(new Array(BUFFER_BYTES).fill(0));
    this.literals = [];   // (start,length) descriptors this expression uses
    this.fb = new Map();  // in-scope feedback names -> producer node index
    this.fbSentinel = -1000;  // unique negative placeholder per in-flight feedback name
    this.env = null;          // macro env (set per compile); `master` is lazily compiled once.
    this._master = null; this._headClk = {};
    this.knobSeeds = {};      // knob index -> boot/sim value, from (knob :which :default V)
  }
  masterClock() {
    if (this._master == null) this._master = this.compile(asTree(expandTree("master", this.env || baseEnv())));
    return this._master;
  }
  // (form ... :clk c) -> compiled clock, else master.
  clockArg(a) { const i = a.indexOf(":clk"); return i >= 0 ? this.compile(a[i + 1]) : this.masterClock(); }
  // Per-sample sweep phasor for an audio tape; shared across all readers/writers of the same tape.
  sweepClock(idx) {
    if (this.sweepClocks[idx] == null) {
      const len = this.tapeLengths[idx] || 1, div = this.tapeClockDivs[idx] || 1;
      const hz = 48000 / (len * div);
      this.sweepClocks[idx] = this.compile(["phasor", ":hz", String(hz)]);
    }
    return this.sweepClocks[idx];
  }
  // Patch forward references: close a feedback sentinel to the real producer index.
  patchRef(sentinel, idx) {
    for (const f of this.nodes)
      for (const k of ["in_a", "in_b", "param_from", "clock_from", "branch_start"])
        if (f[k] === sentinel) f[k] = idx;
  }
  // Resolve a scale to a literal tape (built-in, deduped) or a hardware tape (mutable scale).
  scaleTape(s) {
    if (Array.isArray(s) && s[0] === "lens" && isQuote(s[1])) {       // a value lens (builtin or user)
      const deg = lensValues(s[1][1], this.env);
      return { handle: this.literalTape(deg), len: deg.length };
    }
    const i = tapeIdx(s);
    if (i >= 0) {
      const len = this.tapeLengths[i];
      if (!len) throw new Error("scale tape " + s + " has no length (define it in the patch)");
      return { handle: i, len };
    }
    throw new Error("a scale is a value lens (minor, major, or your own (lens '(...))) or a tape-N, got: " + unparse(s));
  }
  // Alloc bytes into the pool; identical byte runs are deduped.
  literalTape(bytes) {
    const key = bytes.join(",");
    let d = this.pool.dedup.get(key);
    if (!d) { d = this.pool.alloc(bytes); this.pool.dedup.set(key, d); }
    // each expression lists the regions it references (may point at a shared run)
    let li = this.literals.findIndex(x => x.start === d.start && x.length === d.length);
    if (li < 0) { this.literals.push(d); li = this.literals.length - 1; }
    return LITERAL_BASE + li;
  }
  // Map a control to an absolute MIDI note through a scale tape. Returns a note value (composable).
  degree(a) {
    const oct = a[2] !== undefined ? this.int(a[2]) : DEFAULT_OCT;
    if (oct < 1) throw new Error("degree/pitch octave span must be >= 1");
    const { handle, len } = this.scaleTape(a[1]);
    const span = len * oct;
    if (span > 127) throw new Error("degree/pitch span " + span + " > 127 (reduce octaves)");
    const idx = this.emit(this.node("spread", { in_a: this.compile(a[0]), param: span }));
    const deg = this.emit(this.node("lookup", { array_idx: handle, in_a: idx }));
    let note = deg;
    if (oct > 1) {
      const octn  = this.emit(this.node("div", { in_a: idx, param: len }));
      const oct12 = this.emit(this.node("mul", { in_a: octn, param: 12 }));
      note = this.emit(this.node("add", { in_a: deg, in_b: oct12 }));
    }
    return this.emit(this.node("transpose", { in_a: note, param: ROOT_NOTE }), "note");
  }
  findTape(node) {
    if (!Array.isArray(node)) return -1;
    if (node[0] === "step") return tapeIdx(node[1]);
    for (const c of node) { const t = this.findTape(c); if (t >= 0) return t; }
    return -1;
  }
  // Types are advisory (a value is just a number). Default "byte"; bridges change type: note/cv/pulse.
  emit(f, ty = "byte") { this.nodes.push(f); this.types.push(ty); return this.nodes.length - 1; }
  // "audio" if any operand is audio-rate (rate propagates up from source).
  atype(...idx) { return idx.some(i => i >= 0 && this.types[i] === "audio") ? "audio" : "byte"; }
  vOct(inp) { return this.emit(this.node("v-oct", { in_a: inp }), "cv"); }
  // Snap a note to the nearest scale tone. Scale = a 12-bit pitch-class mask; :mask takes a live stream.
  snapNote(a) {
    const o = { in_a: this.compile(a[0]) };
    const mi = a.indexOf(":mask");
    if (mi >= 0) {
      const v = a[mi + 1];
      if (Array.isArray(v)) o.param_from = this.compile(v); else o.param = this.int(v);
    } else {
      const s = a[1];
      if (!(Array.isArray(s) && s[0] === "lens" && isQuote(s[1])))
        throw new Error("snap/quantise takes a value lens (minor, major, (lens '(...))) or :mask m, got: " + unparse(s));
      let m = 0;
      for (const d of lensValues(s[1][1], this.env)) m |= 1 << (((d % 12) + 12) % 12);
      o.param = m;
    }
    return this.emit(this.node("snap", o), "note");
  }
  filterArgs(a) {
    let poles = 1, cut = { val: 128 };
    for (let k = 1; k < a.length; k++) {
      if (a[k] === ":poles") { poles = Math.max(1, Math.min(4, this.int(a[++k]))); }
      else if (a[k] === ":hz") { cut = { val: hzToCutoff(this.int(a[++k])) }; }   // Hz -> one-pole cutoff value
      else if (Array.isArray(a[k])) cut = { from: this.compile(a[k]) };
      else cut = { val: this.int(a[k]) };
    }
    return { poles, cut };
  }
  // cascade `poles` one-pole averages over `sig`, all sharing one cutoff. Each is its
  // own node (own state); nesting is how poles compose, no kernel knows about poles.
  lowpass(sig, cut, poles) {
    let v = sig;
    for (let p = 0; p < poles; p++) {
      const o = { in_a: v };
      if (cut.from !== undefined) o.param_from = cut.from; else o.param = cut.val & 0xFFF;
      v = this.emit(this.node("average", o), "audio");
    }
    return v;
  }
  node(kind, o = {}) {
    return Object.assign({ kind, array_idx:-1, in_a:-1, in_b:-1, param:0,
                           param_from:-1, clock_from:-1, branch_start:-1, branch_count:0 }, o);
  }
  // CSE: identical sub-expressions share one node. This is what makes a switch's
  // branch roots come out consecutive (the shared leaf compiles once).
  compile(node) {
    // a bare number where a stream is expected -> a const leaf, so any
    // two-stream op can take a literal operand: (gt r 100), (add a 5), (xor r 1).
    if (!Array.isArray(node)) {
      if (this.fb.has(node)) return this.fb.get(node);     // in-scope feedback name -> its producer (or sentinel)
      const n = parseInt(node, 10);                        // a note name is NOT a bare value: use :note (see below)
      if (Number.isNaN(n)) throw new Error(parseNoteName(node) !== null
        ? "a note name is not a bare value: write (sine :note " + node + ") or (tape notes '(" + node + " ...))"
        : "expected a node or number, got atom: " + node);
      const ck = "const:" + (n & 0xFFF);
      if (this.memo.has(ck)) return this.memo.get(ck);
      const ci = this.emit(this.node("const", { param: n & 0xFFF }));
      this.memo.set(ck, ci);
      return ci;
    }
    // Identity share-once: a let/define value binds ONE tree object; every reference to the
    // name yields that SAME object, so it compiles once and is reused, INCLUDING impure
    // (random/noise/walk/chance) and feedback nodes that structural CSE must not merge. This
    // is what makes "a binding is one module" literal.
    if (this.shared.has(node)) return this.shared.get(node);
    // NO_CSE nodes must never be merged by STRUCTURE: feedback/z1 hold per-instance state
    // (and read in-scope names that aren't stable keys); random/noise/walk/chance are IMPURE
    // (each occurrence is an independent entropy stream). So two textually distinct ones get
    // separate nodes. Identity sharing above still makes a NAMED binding of any of them ONE
    // shared instance ("a binding is one module").
    if (NO_CSE.has(node[0])) { const i = this.compileRaw(node); this.shared.set(node, i); return i; }
    const key = JSON.stringify(node);
    if (this.memo.has(key)) { const i = this.memo.get(key); this.shared.set(node, i); return i; }
    const idx = this.compileRaw(node);
    this.memo.set(key, idx);
    this.shared.set(node, idx);
    return idx;
  }
  compileRaw(node) {
    if (!Array.isArray(node)) throw new Error("expected a node, got atom: " + node);
    const head = node[0];
    const a = POS_PARAMS[head] ? reorderArgs(head, node.slice(1), POS_PARAMS[head]) : node.slice(1);
    const bin = (k) => { const x = this.compile(a[0]), y = this.compile(a[1]); return this.emit(this.node(k, { in_a: x, in_b: y }), this.atype(x, y)); };
    switch (head) {
      case "z1": {  // (z1 X): one extra register = one sample of explicit delay
        const x = this.compile(a[0]);
        return this.emit(this.node("transpose", { in_a: x, param: 0 }), this.types[x]);
      }
      case "feedback": {
        // (feedback name body) or (feedback ((a A) (b B)..) out): letrec with one-sample-delay reads.
        const multi = Array.isArray(a[0]);
        const binds = multi ? a[0] : [[a[0], a[1]]];
        for (const b of binds)
          if (!Array.isArray(b) || typeof b[0] !== "string") {
            if (!multi) throw new Error("feedback: name must be an atom, got " + JSON.stringify(a[0]));
            throw new Error("feedback: each binding must be (name body), got " + JSON.stringify(b));
          }
        // Each name gets a negative sentinel while its body compiles; forward read = one-sample delay.
        const saved = binds.map(([nm]) => [nm, this.fb.has(nm), this.fb.get(nm)]);
        const sentinels = binds.map(() => this.fbSentinel--);
        binds.forEach(([nm], i) => this.fb.set(nm, sentinels[i]));                      // names in scope (as sentinels)
        const bodies = binds.map(([, be]) => this.compile(be));                         // each body's terminal index
        binds.forEach((_, i) => this.patchRef(sentinels[i], bodies[i]));                // close the forward refs
        binds.forEach(([nm], i) => this.fb.set(nm, bodies[i]));                         // name now -> its producer
        let ret = multi ? this.compile(a[1]) : bodies[0];
        // Terminal must be the last node; emit an identity if ret is earlier.
        if (ret !== this.nodes.length - 1) ret = this.emit(this.node("transpose", { in_a: ret, param: 0 }), this.types[ret]);
        saved.forEach(([nm, had, prev]) => { if (had) this.fb.set(nm, prev); else this.fb.delete(nm); });
        return ret;
      }
      case "edge":   { const x = this.compile(a[0]); return this.emit(this.node("edge", { in_a: x }), this.types[x]); }
      case "diff":   { const x = this.compile(a[0]); return this.emit(this.node("diff", { in_a: x }), this.types[x]); }
      case "toggle": { const x = this.compile(a[0]); return this.emit(this.node("toggle", { in_a: x }), "pulse"); }
      case "schmitt": return this.emit(this.node("schmitt", { in_a: this.compile(a[0]), in_b: this.compile(a[1]), param_from: this.compile(a[2]) }), "pulse");
      case "envfollow": return this.compile(["lpf", ["abs", a[0]], a[1] !== undefined ? a[1] : 32]);   // smoothed full-wave rectify
      case "hold":   { const x = this.compile(a[0]), t = this.compile(a[1]); return this.emit(this.node("hold", { in_a: x, in_b: t }), this.atype(x, t)); }
      case "step": {
        // (step tape [:clk c]): advance one element per clock tick; default clock is master.
        return this.emit(this.node("lookup", { array_idx: this.tape(a[0]), clock_from: this.clockArg(a) }));
      }
      case "seek": {
        // (seek tape ix): arbitrary-index read; (seek tape :clk c) = phasor-driven sequential read.
        const ci = a.indexOf(":clk");
        if (ci >= 0) return this.emit(this.node("lookup", { array_idx: this.tape(a[0]), clock_from: this.compile(a[ci + 1]) }));
        return this.emit(this.node("lookup", { array_idx: this.tape(a[0]), in_a: this.compile(a[1]) }));
      }
      case "clock": {
        const ti = a.indexOf(":times");
        if (ti >= 0) return this.emit(this.node("vclock", { array_idx: this.tape(a[ti + 1]) }), "audio");
        const args = a.slice();
        const bi = args.indexOf(":bpm");
        if (bi >= 0) { args[bi] = ":hz"; args[bi + 1] = String(Number(args[bi + 1]) / 60); }
        return this.compile(["phasor", ...args]);
      }
      // (follow base :mult/:div/:rate/:drift): derived phasor in phase domain.
      // :mult/:div are integer ratios (re-cohere); :rate is a log ratio (drifts).
      case "follow": {
        const base = this.compile(a[0]);
        const mi = a.indexOf(":mult"), di = a.indexOf(":div"), ra = a.indexOf(":rate");
        if (ra >= 0)
          return this.emit(this.node("follow", { in_a: base, array_idx: 2, param_from: this.compile(a[ra + 1]) }), "audio");
        const dr = a.indexOf(":drift");
        const drift = (dr >= 0) ? { param_from: this.compile(a[dr + 1]) } : {};
        if (mi >= 0) return this.emit(this.node("follow", { in_a: base, array_idx: 0, param: this.int(a[mi + 1]), ...drift }), "audio");
        if (di >= 0) return this.emit(this.node("follow", { in_a: base, array_idx: 1, param: this.int(a[di + 1]), ...drift }), "audio");
        return base;
      }
      // (arrange prog [:len N] [:advancing]): data-driven tape combiner; order is data (mutable).
      case "arrange": {
        let len = 0, adv = 0; const idxArgs = [];
        for (let k = 0; k < a.length; k++) {
          if      (a[k] === ":len") len = this.int(a[++k]);
          else if (a[k] === ":advancing" || a[k] === ":adv") adv = 1;
          else if (a[k] === ":clk") k++;                 // consumed by clockArg below
          else idxArgs.push(a[k]);
        }
        const prog = (idxArgs.length === 1 && tapeIdx(idxArgs[0]) >= 0)
                   ? this.tape(idxArgs[0])
                   : this.literalTape(idxArgs.map(t => this.tape(t)));
        return this.emit(this.node("arrange", { array_idx: prog, param: len, branch_count: adv, clock_from: this.clockArg(a) }));
      }
      case "tap": {
        // (tap tape N [:interp] [:span]): read N samples behind the write head.
        // :interp smooths a modulated offset; :span maps 0..VMAX across the whole tape.
        // Note: :span is only applied on the stream path; always compile as stream when :span.
        const o = { array_idx: this.tape(a[0]), clock_from: this.sweepClock(this.tape(a[0])) };
        const interp = a.includes(":interp");
        const span = a.includes(":span");
        if (Array.isArray(a[1]) || span) { o.param_from = this.compile(a[1]); o.param = (interp ? 1 : 0) | (span ? 2 : 0); }
        else if (a[1] !== undefined && !String(a[1]).startsWith(":"))
          o.param = this.int(a[1]);
        else o.param = 0;   // offset 0 = oldest sample (Karplus-Strong: (tap t))
        return this.emit(this.node("tap", o), "audio");
      }
      case "vcf": {
        // (vcf sig cutoff res [:lp|:hp|:bp|:notch] [:poles 4]): 2-pole SVF, all bands at once.
        // :poles 4 cascades a second stage (24 dB/oct).
        const mode = { ":lp": 0, ":hp": 1, ":bp": 2, ":notch": 3 };
        let m = 0; for (const k of a.slice(3)) if (mode[k] !== undefined) m = mode[k];
        const cut = this.compile(a[1]);
        let sig = this.emit(this.node("vcf", { in_a: this.compile(a[0]), in_b: cut,
                                               param_from: this.compile(a[2]), param: m }), "audio");
        const pi = a.indexOf(":poles");
        if (pi >= 0 && this.int(a[pi + 1]) >= 3)
          sig = this.emit(this.node("vcf", { in_a: sig, in_b: cut, param_from: this.compile(0), param: m }), "audio");
        return sig;
      }
      case "crush": {
        // (crush x N): sample-rate decimator. N const or stream; pair with `mask` for bit-crush.
        const o = { in_a: this.compile(a[0]) };
        if (Array.isArray(a[1])) o.param_from = this.compile(a[1]); else o.param = this.int(a[1]);
        return this.emit(this.node("crush", o), "audio");
      }
      case "wave": {              // (wave tape [pitch|:note N] [:reverse] [:expand] [:pos c] [:interp c] [:scan c] [:once [trig]] [:slots N :pick c])
        let pitch = -1, mode = 0, posFrom = -1, interpFrom = -1, scanFrom = -1, onceTrig = -1, slots = 0, k = 1;
        if (a[k] !== undefined && !String(a[k]).startsWith(":")) { pitch = this.compile(a[k]); k++; }
        for (; k < a.length; k++) {
          if      (a[k] === ":note") { const v = noteValue(a[++k]); if (v === null) throw new Error("(wave :note X): not a note name: " + a[k]); pitch = this.compile(String(v)); }
          else if (a[k] === ":reverse") mode |= 1;
          else if (a[k] === ":expand")  mode |= 2;        // µ-law decode (expansive waveshaper)
          else if (a[k] === ":once") {                    // one-shot: one pass on trigger, then silence
            mode |= 4;
            if (a[k + 1] !== undefined && !String(a[k + 1]).startsWith(":")) onceTrig = this.compile(a[++k]);
            else onceTrig = this.compile(["tick"]);       // default trigger: the master tick
          }
          else if (a[k] === ":slots")   slots = this.int(a[++k]);          // drum rack: N equal slots
          else if (a[k] === ":pick")    posFrom = this.compile(a[++k]);    // which slot to play
          else if (a[k] === ":pos")     posFrom = this.compile(a[++k]);    // scrub/jump offset
          else if (a[k] === ":interp")  interpFrom = this.compile(a[++k]); // 0 = S+H .. 255 = linear
          else if (a[k] === ":scan")    scanFrom = this.compile(a[++k]);   // slide read window start (wavetable scan)
        }
        return this.emit(this.node("wave", { array_idx: this.tape(a[0]), in_a: pitch, param: mode,
                                             param_from: posFrom, in_b: interpFrom, branch_count: slots,
                                             clock_from: (mode & 4) ? onceTrig : scanFrom }), "audio");
      }
      // (sine/triangle/saw/square [pitch|:note N|:hz N|:rate c] [:fm m|:pm m] [:depth D] [:sync s] [:width w])
      case "sine": case "triangle": case "saw": case "square": {
        // Pitch always goes through an injected phasor. The phasor takes :note/:hz/:rate/
        // :tempo/:cents/:sync/:phase and now :fm/:depth too. The shape just reads the
        // phasor's phase+inc and renders the waveform, with :pm modulating the lookup
        // phase at the shape itself (no integration needed for PM).
        const shape = { sine: 0, triangle: 1, saw: 2, square: 3 }[head];
        let noteNode = null, fmNode = null, pmNode = null, depth = 0, depthStream = null;
        let syncNode = null, widthNode = null, rateArgs = [], k = 0;
        if (a[0] !== undefined && !String(a[0]).startsWith(":")) { noteNode = a[0]; k = 1; }
        for (; k < a.length; k++) {
          if      (a[k] === ":note") { const v = noteValue(a[++k]); if (v === null) throw new Error("(" + head + " :note X): not a note name: " + a[k]); noteNode = String(v); }
          else if (a[k] === ":midi") noteNode = a[++k];
          else if (a[k] === ":fm")    fmNode = a[++k];                                // linear FM at the phasor
          else if (a[k] === ":pm")    pmNode = a[++k];                                // phase mod at the shape
          else if (a[k] === ":depth") { const v = a[++k];
            if (Array.isArray(v)) { depthStream = v; depth = 127; }
            else depth = this.int(v); }
          else if (a[k] === ":sync")  syncNode = a[++k];
          else if (a[k] === ":width" || a[k] === ":pwm") widthNode = a[++k];
          else if (a[k] === ":hz" || a[k] === ":khz" || a[k] === ":rate"
                || a[k] === ":cents" || a[k] === ":phase") rateArgs.push(a[k], a[++k]);
        }
        if (fmNode !== null && pmNode !== null)
          throw new Error("(" + head + " ...): :fm and :pm are alternatives, not both");
        // Collapse :depth-stream into the modulator at compile time (it's a VCA on the mod).
        let mod = fmNode !== null ? fmNode : pmNode;
        if (depthStream !== null && mod !== null) mod = ["vca", mod, depthStream];
        const pargs = ["phasor"];
        if (noteNode !== null) pargs.push(noteNode);
        pargs.push(...rateArgs);
        if (syncNode !== null) pargs.push(":sync", syncNode);
        if (fmNode !== null) {
          pargs.push(":fm", mod);
          if (depth !== 0 && depthStream === null) pargs.push(":depth", String(depth));
        }
        const pitch = this.compile(pargs);
        const o = { in_a: pitch,
          in_b:      pmNode !== null ? this.compile(mod) : -1,
          array_idx: pmNode !== null ? depth : 0,
          param:     shape | (pmNode !== null ? 4 : 0) };
        if (head === "square" && widthNode !== null) o.param_from = this.compile(widthNode);
        return this.emit(this.node("shape", o), "audio");
      }
      case "phasor": {
        // (phasor [note|:hz N|:khz N|:rate c|:tempo c] [:cents c] [:phase deg] [:sync s]
        //         [:fm modulator [:depth 0..127]])
        // param: bits 0-1 = mode (0=NOTE, 1=RATE, 2=HZ, 3=TEMPO);
        //        bits 2-11 = :phase offset (1024 steps per turn);
        //        bits 12-18 = :fm :depth (0..127), nonzero implies FM enabled when param_from is set.
        const o = { param: 0 };
        let k = 0, fmDepth = 0;
        if (a[0] !== undefined && !String(a[0]).startsWith(":")) { o.in_a = this.compile(a[0]); k = 1; }
        for (; k < a.length; k++) {
          if (a[k] === ":hz" || a[k] === ":khz") {
            const hz = Number(a[++k]) * (a[k - 1] === ":khz" ? 1000 : 1);
            let inc = Math.round(hz * 4294967296 / 48000) % 4294967296;
            if (inc < 0) inc += 4294967296;
            o.array_idx = this.literalTape([inc & 0xFFF, (inc >>> 12) & 0xFFF, (inc >>> 24) & 0xFF]);
            o.param = (o.param & ~3) | 2;
            o._hz = hz;   // analysis hint (not serialized): used by interval pass for slow LFOs
          } else if (a[k] === ":rate") { o.in_a = this.compile(a[++k]); o.param = (o.param & ~3) | 1; }
          else if (a[k] === ":tempo") { o.in_a = this.compile(a[++k]); o.param = (o.param & ~3) | 3; }
          else if (a[k] === ":sync")  { o.clock_from = this.compile(a[++k]); }
          else if (a[k] === ":cents") { o.in_b = this.compile(a[++k]); }   // fine detune; vmid=0, rails~±100¢
          else if (a[k] === ":fm")    { o.param_from = this.compile(a[++k]); if (fmDepth === 0) fmDepth = 64; }  // linear FM mod; default depth 64
          else if (a[k] === ":depth") { fmDepth = this.int(a[++k]) & 0x7F; }
          else if (a[k] === ":phase") {                                    // initial phase, degrees
            const deg = Number(a[++k]);
            o.param = (o.param & 3) | ((Math.round(((deg % 360) + 360) % 360 * 1024 / 360) & 0x3FF) << 2);
          }
        }
        if (fmDepth > 0) o.param = (o.param & ~(0x7F << 12)) | (fmDepth << 12);
        return this.emit(this.node("phasor", o), "audio");
      }
      // vca = signal×control-gain (mul mode 2), ring = four-quadrant (mode 4), mix = saturating sum.
      case "vca": case "ring": {
        const o = { in_a: this.compile(a[0]), array_idx: head === "vca" ? 2 : 4 };
        if (Array.isArray(a[1])) o.param_from = this.compile(a[1]); else o.param = this.int(a[1]);
        return this.emit(this.node("mul", o), "audio");
      }
      case "mix": {
        // (mix a b ... [:unity] [:levels (l0 l1 ...)]): variadic sum. :unity normalises to 1/n; :levels to ratios.
        let levels = null, unity = false; const srcs = [];
        for (let k = 0; k < a.length; k++) {
          if (a[k] === ":levels") { levels = a[++k]; unity = true; }
          else if (a[k] === ":unity") unity = true;
          else srcs.push(a[k]);
        }
        const n = srcs.length;
        if (n === 0) throw new Error("(mix ...) needs at least one source");
        if (!unity) {
          let v = this.compile(srcs[0]);
          for (let i = 1; i < n; i++) v = this.emit(this.node("add", { in_a: v, in_b: this.compile(srcs[i]) }), "audio");
          return v;
        }
        let gains;
        if (levels) {
          if (!Array.isArray(levels) || levels.length !== n)
            throw new Error("(mix ... :levels (l0 l1 ...)) needs one level per source");
          const ls = levels.map(x => this.int(x)), sum = ls.reduce((p, q) => p + q, 0) || 1;
          gains = ls.map(l => Math.max(0, Math.min(VMAX, Math.round(l / sum * VMAX))));
        } else { const g = Math.round(VMAX / n); gains = srcs.map(() => g); }
        const scaled = (i) => this.emit(this.node("mul", { in_a: this.compile(srcs[i]), param: gains[i], array_idx: 2 }), "audio");
        let v = scaled(0);
        for (let i = 1; i < n; i++) v = this.emit(this.node("add", { in_a: v, in_b: scaled(i) }), "audio");
        return v;
      }
      case "shift":   return this.emit(this.node("shift",  { in_a: this.compile(a[0]), param: this.int(a[1]) }));
      case "transpose": {                                 // type-preserving: +N on a note = octave; on a value = nudge
        const inp = this.compile(a[0]);
        const o = { in_a: inp };
        if (Array.isArray(a[1])) o.param_from = this.compile(a[1]); else o.param = this.int(a[1]);
        return this.emit(this.node("transpose", o), this.types[inp]);
      }
      case "invert":  { const x = this.compile(a[0]); return this.emit(this.node("invert", { in_a: x }), this.types[x]); }
      case "xor": case "and": case "or":
      case "gt": case "gte": case "lt": case "lte": case "eq": case "ne": return bin(head);
      case "mask":  { const x = this.compile(a[0]), o = { in_a: x };
                      if (Array.isArray(a[1])) o.param_from = this.compile(a[1]); else o.param = this.int(a[1]);
                      return this.emit(this.node("mask", o), this.types[x]); }
      case "bit":   { const x = this.compile(a[0]); return this.emit(this.node("bit",  { in_a: x, param: this.int(a[1]) }), this.types[x]); }
      case "counter": return this.emit(this.node("counter", { param: this.barlen(a[0]), clock_from: this.clockArg(a) }));
      case "degree":  return this.degree(a);              // value -> note
      case "pitch":   return this.vOct(this.degree(a));  // sugar: v-oct over degree
      case "snap":     return this.snapNote(a);            // snap note to scale -> note
      case "quantise": return this.vOct(this.snapNote(a)); // sugar: v-oct over snap
      case "v-oct": {
        if (a[0] === ":note") { const v = noteValue(a[1]); if (v === null) throw new Error("(v-oct :note X): not a note name: " + a[1]); return this.vOct(this.compile(String(v))); }
        return this.vOct(this.compile(a[0]));
      }
      case "cv":    return this.emit(this.node("cv", { in_a: this.compile(a[0]),
                                                       param: (a[1] === ":bipolar" || a[1] === ":bi") ? 1 : 0 }), "cv");
      case "slew": {                                      // glide/smoother; type-preserving
        let rate = 8, rateFrom = -1;
        const setRate = v => { if (Array.isArray(v)) rateFrom = this.compile(v); else rate = this.int(v); };
        if (a[1] !== undefined && !String(a[1]).startsWith(":")) setRate(a[1]);
        for (let k = 1; k < a.length; k++) if (a[k] === ":rate") setRate(a[++k]);
        const inp = this.compile(a[0]);
        return this.emit(this.node("slew", { in_a: inp, param: rate, param_from: rateFrom }), this.types[inp] || "cv");
      }
      case "envelope": {                                  // (envelope [amp] :trig|:gate src :decay d)
        let decay = 16, decayFrom = -1, clk = -1, mode = 0, amp = -1, start = 0;  // decay in 1/16-beat units
        if (a[0] !== undefined && !String(a[0]).startsWith(":")) { amp = this.compile(a[0]); start = 1; }
        for (let k = start; k < a.length; k++) {
          if      (a[k] === ":decay") { const v = a[++k]; if (Array.isArray(v)) decayFrom = this.compile(v); else decay = this.int(v); }
          else if (a[k] === ":peak")  { amp = this.compile(a[++k]); }
          else if (a[k] === ":trig")  { clk = this.compile(a[++k]); mode = 0; }
          else if (a[k] === ":gate")  { clk = this.compile(a[++k]); mode = 1; }
        }
        // Default trigger: master beat tick (not the phasor ramp, which never crosses VMID).
        return this.emit(this.node("envelope", { in_a: amp, param: decay, param_from: decayFrom, clock_from: clk < 0 ? this.compile(["tick"]) : clk, array_idx: mode }), "cv");
      }
      case "lookup":  return this.emit(this.node("lookup", { array_idx: this.tape(a[0]), in_a: this.compile(a[1]) }));
      case "spread": case "mul": case "div": case "mod": {
        // mul: saturates by default; :wrap folds/aliases; :bipolar = attenuverter (gain centred at 2048).
        const o = { in_a: this.compile(a[0]) };
        if (Array.isArray(a[1])) o.param_from = this.compile(a[1]); else o.param = this.int(a[1]);
        if (head === "mul" && a[2] === ":wrap") o.array_idx = 1;
        if (head === "mul" && (a[2] === ":bipolar" || a[2] === ":bi")) {
          o.array_idx = 3;
          return this.emit(this.node("mul", o), "audio");
        }
        return this.emit(this.node(head, o), this.atype(o.in_a, o.param_from ?? -1));
      }
      case "add": case "sub": {
        // Wraps by default; :sat clamps to 0..VMAX.
        const o = { in_a: this.compile(a[0]), in_b: this.compile(a[1]) };
        if (a[2] === ":sat") o.array_idx = 1;
        return this.emit(this.node(head, o), this.atype(o.in_a, o.in_b));
      }
      // tick = one-sample pulse per clock turn; turns = running turn count.
      case "tick":  { const clk = (a[0] !== undefined) ? this.compile(a[0]) : this.masterClock();
                      return this.emit(this.node("tick", { clock_from: clk }), "pulse"); }
      case "turns": { const clk = (a[0] !== undefined) ? this.compile(a[0]) : this.masterClock();
                      return this.emit(this.node("turns", { clock_from: clk })); }
      case "random": {
        let shape = 128, shapeFrom = -1;
        for (let k = 0; k < a.length; k++)
          if (a[k] === ":shape") { const v = a[++k]; if (Array.isArray(v)) shapeFrom = this.compile(v); else shape = this.int(v); }
        return this.emit(this.node("random", { param: shape, param_from: shapeFrom, clock_from: this.clockArg(a) }));
      }
      case "knob": {
        // (knob :main|:x|:y [:default V]): reads a panel pot; :default is the boot/sim value.
        const names = { ":main": 0, ":x": 1, ":y": 2 };
        let p = 0;
        for (let k = 0; k < a.length; k++) {
          if (names[a[k]] !== undefined) p = names[a[k]];
          else if (a[k] === ":default") this.knobSeeds[p] = this.int(a[k + 1]) & 0xFFF;
        }
        return this.emit(this.node("knob", { param: p }));
      }
      case "cv-in":      return this.emit(this.node("cv-in",   { param: this.int(a[0]) | (a[1] === ":v-oct" ? 0x40 : 0) }));
      case "pulse-in":   return this.emit(this.node("pulse-in",{ param: this.int(a[0]) }));
      case "audio-in":   return this.emit(this.node("audio-in",{ param: this.int(a[0]) }), "audio");
      case "active-page":return this.emit(this.node("active-page"));
      case "switch-pos": return this.emit(this.node("switch-pos"));
      case "frozen":     return this.emit(this.node("frozen", { array_idx: this.tape(a[0]) }), "pulse");
      case "connected": {
        const base = { "audio-in": 0, "cv-in": 2, "pulse-in": 4 }[a[0]];
        if (base === undefined) throw new Error("connected: jack must be audio-in/cv-in/pulse-in, got " + a[0]);
        return this.emit(this.node("connected", { param: base + (this.int(a[1]) === 2 ? 1 : 0) }), "pulse");
      }
      // `average` = one-pole EMA; lpf/hpf/bpf/lpg are sugar over it. cutoff 0=shut..255=open.
      case "average": case "lpf": {
        const { poles, cut } = this.filterArgs(a);
        return this.lowpass(this.compile(a[0]), cut, poles);
      }
      case "hpf": {
        const { poles, cut } = this.filterArgs(a);
        const sig = this.compile(a[0]);
        return this.emit(this.node("sub", { in_a: sig, in_b: this.lowpass(sig, cut, poles) }), "audio");
      }
      case "bpf": {
        const { poles, cut } = this.filterArgs(a);
        const sig = this.compile(a[0]);
        const hp = this.emit(this.node("sub", { in_a: sig, in_b: this.lowpass(sig, cut, poles) }), "audio");
        return this.lowpass(hp, cut, poles);
      }
      case "lpg": {                                       // (lpg sig ctrl): one control opens VCA + filter together
        const ctrl = this.compile(a[1]);
        const v = this.emit(this.node("mul", { in_a: this.compile(a[0]), param_from: ctrl }), "audio");
        return this.lowpass(v, { from: ctrl }, 1);
      }
      case "wavefold": {                                  // (wavefold sig [drive]): triangle folder; drive 0=clean..255=heavy
        const o = { in_a: this.compile(a[0]) };
        if (a[1] === undefined)        o.param = 64;
        else if (Array.isArray(a[1]))  o.param_from = this.compile(a[1]);
        else                           o.param = this.int(a[1]);
        return this.emit(this.node("wavefold", o), "audio");
      }
      case "kick": {                                      // (kick [pitch] [:note N|:midi N] [:decay d] [:drive g] [:sweep s] [:trig clk])
        let pitchArg = null, decayArg = "2048", driveArg = "0", sweep = 2048, sweepFrom = -1, clk = -1, k = 0;
        if (a[0] !== undefined && !String(a[0]).startsWith(":")) { pitchArg = a[0]; k = 1; }
        for (; k < a.length; k++) {
          if      (a[k] === ":note")  { const v = noteValue(a[++k]); if (v === null) throw new Error("(kick :note X): not a note name: " + a[k]); pitchArg = String(v); }
          else if (a[k] === ":midi")  pitchArg = a[++k];
          else if (a[k] === ":decay") decayArg = a[++k];
          else if (a[k] === ":drive") driveArg = a[++k];
          else if (a[k] === ":sweep") { const v = a[++k]; if (Array.isArray(v)) sweepFrom = this.compile(v); else sweep = this.int(v) & 0xFFF; }
          else if (a[k] === ":trig")  clk = this.compile(a[++k]);
          else throw new Error("(kick ...): unknown arg " + a[k]);
        }
        return this.emit(this.node("kick", {
          in_a: pitchArg !== null ? this.compile(pitchArg) : -1,
          in_b: this.compile(decayArg),
          param_from: this.compile(driveArg),
          param: sweep, branch_start: sweepFrom,
          clock_from: clk < 0 ? this.compile(["tick"]) : clk,
        }), "audio");
      }
      case "beat": throw new Error("(beat ...) is a rhythm tape, not a value: use it where a tape goes (step, onsets, hits, a groove voice) or bind it, e.g. (def fill (beat x.xx.x.x))");
      case "snare": {                                     // (snare [pitch] [:note N|:midi N] [:decay d] [:snappy s] [:tone t] [:trig clk])
        let pitchArg = null, decayArg = "2048", snappyArg = "2048", tone = 2600, toneFrom = -1, clk = -1, k = 0;
        if (a[0] !== undefined && !String(a[0]).startsWith(":")) { pitchArg = a[0]; k = 1; }
        for (; k < a.length; k++) {
          if      (a[k] === ":note")   { const v = noteValue(a[++k]); if (v === null) throw new Error("(snare :note X): not a note name: " + a[k]); pitchArg = String(v); }
          else if (a[k] === ":midi")   pitchArg = a[++k];
          else if (a[k] === ":decay")  decayArg = a[++k];
          else if (a[k] === ":snappy") snappyArg = a[++k];
          else if (a[k] === ":tone")   { const v = a[++k]; if (Array.isArray(v)) toneFrom = this.compile(v); else tone = this.int(v) & 0xFFF; }
          else if (a[k] === ":trig")   clk = this.compile(a[++k]);
          else throw new Error("(snare ...): unknown arg " + a[k]);
        }
        return this.emit(this.node("snare", {
          in_a: pitchArg !== null ? this.compile(pitchArg) : -1,
          in_b: this.compile(decayArg), param_from: this.compile(snappyArg),
          param: tone, branch_start: toneFrom, clock_from: clk < 0 ? this.compile(["tick"]) : clk,
        }), "audio");
      }
      case "hat": {                                       // (hat [pitch] [:note N|:midi N] [:decay d] [:tone t] [:trig clk])
        let pitchArg = null, decayArg = "1000", toneArg = "2600", clk = -1, k = 0;
        if (a[0] !== undefined && !String(a[0]).startsWith(":")) { pitchArg = a[0]; k = 1; }
        for (; k < a.length; k++) {
          if      (a[k] === ":note")  { const v = noteValue(a[++k]); if (v === null) throw new Error("(hat :note X): not a note name: " + a[k]); pitchArg = String(v); }
          else if (a[k] === ":midi")  pitchArg = a[++k];
          else if (a[k] === ":decay") decayArg = a[++k];
          else if (a[k] === ":tone")  toneArg = a[++k];
          else if (a[k] === ":trig")  clk = this.compile(a[++k]);
          else throw new Error("(hat ...): unknown arg " + a[k]);
        }
        return this.emit(this.node("hat", {
          in_a: pitchArg !== null ? this.compile(pitchArg) : -1,
          in_b: this.compile(decayArg), param_from: this.compile(toneArg),
          param: 0, clock_from: clk < 0 ? this.compile(["tick"]) : clk,
        }), "audio");
      }
      case "chance":   return this.emit(this.node("chance", { in_a: this.compile(a[0]), clock_from: this.clockArg(a) }));
      case "noise": {                                     // (noise [:hz N]): white, or S&H at N Hz; :rate means a stream
        let hold = 0;
        const ri = a.indexOf(":hz");
        if (ri >= 0) {
          const hz = Number(a[ri + 1]); if (!(hz > 0)) throw new Error("(noise :hz N): N must be > 0");
          hold = Math.max(2, Math.min(4095, Math.round(48000 / hz)));
        }
        if (a.includes(":rate")) throw new Error("(noise :hz N): a literal rate is :hz (:rate means a control stream)");
        return this.emit(this.node("noise", { param: hold }), "audio");
      }
      case "walk": {
        let step = 1;
        for (let k = 0; k < a.length; k++)
          if (a[k] === ":step") step = this.int(a[++k]);
        return this.emit(this.node("walk", { param: step, clock_from: this.clockArg(a) }));
      }
      case "gate": case "trig": {
        // Threshold -> pulse on a pulse jack. trig = min width, gate = full-beat.
        const inp = this.compile(a[0]);
        let len = (head === "trig") ? 0 : 4095;  // gate held (full beat) by default; trig short
        let lenFrom = -1, thr = -1;
        const rest = a.slice(1);
        for (let k = 0; k < rest.length; k++) {
          const t = rest[k];
          if      (t === "trig") len = 0;
          else if (t === "gate") len = 4095;
          else if (t === ":len") { const v = rest[++k]; if (Array.isArray(v)) lenFrom = this.compile(v); else len = this.int(v); }
          else if (t === ":thresh") thr = this.compile(rest[++k]);
        }
        return this.emit(this.node("gate", { in_a: inp, in_b: thr, param: len, param_from: lenFrom }), "pulse");
      }
      case "thru": {
        // (thru :lens L :at sel)         -> the entry L[sel mod N] as a value:
        //                                   value lens returns the looked-up value,
        //                                   op lens returns the chosen op's position in [0..VMAX].
        // (thru :lens L :at sel :on x)   -> op lens only: apply L[sel mod N] to x.
        const lensIx = a.indexOf(":lens"), atIx = a.indexOf(":at"), onIx = a.indexOf(":on");
        if (lensIx < 0 || atIx < 0)
          throw new Error("(thru :lens L :at sel [:on x]): :lens and :at are required");
        const L = a[lensIx + 1];
        const selSrc = a[atIx + 1];
        const operand = onIx >= 0 ? a[onIx + 1] : undefined;
        if (!Array.isArray(L) || L[0] !== "lens")
          throw new Error("(thru :lens L ...): L must be a lens, (def L (lens ...)) or inline (lens ...)");
        const species = validateLens(L, this.env);
        const sel = this.compile(selSrc);
        if (species === "value") {
          if (operand !== undefined)
            throw new Error("(thru :lens L :at sel :on x): this lens holds VALUES, not ops, drop :on, or "
                          + "remove the quote in the lens to reference functions");
          return this.emit(this.node("lookup", { array_idx: this.literalTape(lensValues(L[1][1], this.env)), in_a: sel }));
        }
        if (operand === undefined) {
          const N = L.length - 1;
          if (N < 2) return this.compile("0");
          return this.compile(["mul", ["mod", selSrc, String(N)], String(Math.floor(VMAX / (N - 1)))]);
        }
        return this.dispatch(sel, L.slice(1).map(fn => asTree(expandTree([fn, operand], this.env))));
      }
      case "lens":
        throw new Error("a lens is a vocabulary, not a stream: read through it with (thru L sel [x]) "
                      + "or encode a tape with (tape L '(tokens))");
      case "switch": return this.dispatch(this.compile(a[0]), a.slice(1));
      case "if": return this.dispatch(this.compile(["gt", a[0], 0]), [a[2] !== undefined ? a[2] : 0, a[1]]);
      case "not": return this.compile(["eq", a[0], 0]);
      case "max":    return this.compile(["if", ["gt", a[0], a[1]], a[0], a[1]]);
      case "min":    return this.compile(["if", ["lt", a[0], a[1]], a[0], a[1]]);
      case "window": return this.compile(["and", ["gt", a[0], a[1]], ["lt", a[0], a[2]]]);
      case "abs":    return this.compile(["if", ["gt", a[0], 0], a[0], ["sub", 0, a[0]]]);
      case "detent": {
        // (detent x p0 p1 ... [:width w]): snap to nearest detent within +-w; pass through otherwise.
        // Bounds are clamped at compile time (gte/lte avoids 12-bit wrap on signed subtract).
        let w = 96; const pts = [];
        for (let k = 1; k < a.length; k++) { if (a[k] === ":width") w = this.int(a[++k]); else pts.push(this.int(a[k])); }
        let tree = a[0];
        for (let i = pts.length - 1; i >= 0; i--) {
          const lo = Math.max(0, pts[i] - w), hi = Math.min(VMAX, pts[i] + w);
          tree = ["if", ["and", ["gte", a[0], lo], ["lte", a[0], hi]], pts[i], tree];
        }
        return this.compile(tree);
      }
      case "rect":   return this.compile(["if", ["gt", a[0], 0], a[0], 0]);
      case "fall":   return this.compile(["edge", ["not", a[0]]]);
      case "len": {
        // (len tape): the tape's length as a compile-time constant; lets patches stay
        // free of magic counts that should track the tape's shape.
        const i = tapeIdx(a[0]);
        if (i < 0 || this.tapeLengths[i] === undefined)
          throw new Error("(len X): X must be a tape (got " + a[0] + ")");
        return this.compile(String(this.tapeLengths[i]));
      }
      case "range": {
        // (range v :to-index N): v in [0..vmax] -> [0..N-1].
        // (range v :to-value N): v in [0..N-1]  -> [0..vmax].
        const k = a.indexOf(":to-index") >= 0 ? ":to-index"
                : a.indexOf(":to-value") >= 0 ? ":to-value"
                : null;
        if (k === null) throw new Error("(range v :to-index N | :to-value N) needs a direction");
        const N = a[a.indexOf(k) + 1];
        if (k === ":to-index") return this.compile(["spread", a[0], N]);
        // mul saturates so we need the divide first; for literal N this folds to a const.
        return this.compile(["mul", a[0], ["div", String(VMAX), ["sub", N, "1"]]]);
      }
      case "every":  return this.compile(["eq", ["mod", ["turns"], a[0]], 0]);
      case "euclid": {
        // (euclid P S [:clk c]): live Euclidean gate; P and S accept streams for runtime density control.
        const c = a.indexOf(":clk");
        const i = c >= 0 ? ["turns", a[c + 1]] : ["turns"];
        const P = a[0], S = a[1];
        return this.compile(["lt", ["mod", ["mul", ["mod", i, S], P], S], P]);
      }
      case "splice": {
        // Phase-locked branch selector: each branch keeps its own playhead; :len N = steps per branch.
        let len = null; const branchNodes = [];
        for (let k = 0; k < a.length; k++) {
          if (a[k] === ":len") len = this.int(a[++k]); else branchNodes.push(a[k]);
        }
        const bar = (len !== null) ? len : (this.tapeLengths[this.findTape(branchNodes[0])] || 16);
        return this.dispatch(this.emit(this.node("counter", { param: bar, clock_from: this.masterClock() })), branchNodes);
      }
      default: throw new Error("unknown node: " + head);
    }
  }
  // Branch dispatch: branch roots must be consecutive; emit identity aliases if not.
  dispatch(selIdx, branches) {
    const roots = branches.map(b => this.compile(b));
    let start = roots[0];
    const consecutive = roots.every((r, k) => r === roots[0] + k);
    if (!consecutive) {
      start = this.nodes.length;
      for (const r of roots) this.emit(this.node("transpose", { in_a: r, param: 0 }), this.types[r]);
    }
    return this.emit(this.node("switch", { in_a: selIdx, branch_start: start, branch_count: roots.length }),
                     this.types[roots[0]]);
  }
  // Resolve a tape arg: tape-N handle, (beat ...) literal, (curve ...) or (table ...) baked at compile time.
  tape(s) {
    if (Array.isArray(s)) {
      if (s[0] === "beat")  return this.literalTape(beatValues(s.slice(1)));
      if (s[0] === "curve") return this.curveTable(s.slice(1));
      if (s[0] === "table") return this.exprTable(s.slice(1));
      throw new Error("bad tape arg: " + JSON.stringify(s));
    }
    if (typeof s === "string" && /^[xX.\-_|]+$/.test(s)) return this.literalTape(beatValues([s]));
    const i = tapeIdx(s); if (i >= 0) return i; throw new Error("bad tape: " + s);
  }
  // (curve TYPE N): N-value literal tape of a standard waveform, scaled to VMAX.
  curveTable(a) {
    const type = a[0], N = this.int(a[1]); const vals = [];
    for (let i = 0; i < N; i++) {
      const t = i / N; let v;                                  // t in [0,1)
      switch (type) {
        case "sine":   v = (1 + Math.sin(2 * Math.PI * t)) / 2; break;
        case "tri":    v = t < 0.5 ? 2 * t : 2 - 2 * t;         break;
        case "saw": case "ramp": v = t;                        break;
        case "square": v = t < 0.5 ? 1 : 0;                    break;
        case "exp":    v = (Math.pow(VMAX + 1, t) - 1) / VMAX;  break;
        case "log":    v = Math.log(1 + t * VMAX) / Math.log(VMAX + 1); break;
        default: throw new Error("unknown curve: " + type + " (sine/tri/saw/square/exp/log)");
      }
      vals.push(Math.max(0, Math.min(VMAX, Math.round(v * VMAX))));
    }
    return this.literalTape(vals);
  }
  // (table N EXPR): compile-time N-value tape; EXPR is pure arithmetic over `i` (0..N-1) and `n`.
  exprTable(a) {
    const N = this.int(a[0]), body = a[1];
    const ev = (node, i) => {
      if (!Array.isArray(node)) { if (node === "i") return i; if (node === "n") return N; return this.int(node); }
      const A = node.slice(1), E = k => ev(A[k], i);
      const r = evalArithOp(node[0], () => E(0), () => E(1));
      if (r !== undefined) return r;
      throw new Error("table: unsupported op '" + node[0] + "' (pure arithmetic/bitwise + i/n only)");
    };
    const vals = [];
    for (let i = 0; i < N; i++) vals.push(Math.max(0, Math.min(VMAX, ev(body, i))));
    return this.literalTape(vals);
  }
  int(s) { const n = parseInt(s, 10); if (Number.isNaN(n)) throw new Error("bad int: " + s); return n; }
  barlen(s) { if (s === ":bar" || s === undefined) return 16; if (s === ":beat") return 1; return this.int(s); }
}


// Compile a single standalone expression (editor probe / --intervals). A patch uses compileGraph.
function compileExpr(src, tapeLengths = {}, pool = null, env = null) {
  const c = new Compiler(tapeLengths, pool);
  c.env = env || baseEnv();
  c.compile(asTree(expandTree(read(tokenize(src)), c.env)));
  if (c.nodes.length > KNODEPOOL)
    throw new Error(`expression too complex: ${c.nodes.length} nodes exceeds the ${KNODEPOOL}-node budget. `
                  + `Simplify it, or factor shared parts with (let ...).`);
  return { nodes: finalize(c.nodes), literals: c.literals };
}

// Compile all roles into one shared graph so CSE and share-once span jacks.
// Each role records its terminal node index (-1 = empty). Srcs arrive pre-expanded.
function compileGraph(roles, tapeLengths, pool, env, tapeClockDivs = {}) {
  const gc = new Compiler(tapeLengths, pool, tapeClockDivs);
  gc.env = env;
  for (const role of roles) {
    let term = -1;
    const src = role.src;
    if (src != null && (typeof src !== 'string' || src.trim()))
      term = gc.compile(asTree(asForm(src)));
    // Record clock: sample tape = sweep clock; control tape = explicit :clk, carried clock, or master.
    if (role.kind === 'record' && term >= 0) {
      if ((gc.tapeClockDivs[role.tape] || 0) > 0) {
        if (role.clockSrc != null)
          throw new Error("(record tape-" + role.tape + " ... :clk): a sample tape writes on its sweep clock");
        gc.nodes[term].clock_from = gc.sweepClock(role.tape);
      } else if (role.clockSrc != null) {
        const clk = gc.compile(asTree(asForm(role.clockSrc)));
        if (gc.nodes[term].clock_from < 0) gc.nodes[term].clock_from = clk;
        else if (gc.nodes[term].clock_from !== clk)
          term = gc.emit(gc.node("transpose", { in_a: term, param: 0, clock_from: clk }), gc.types[term]);
      } else if (gc.nodes[term].clock_from < 0)
        gc.nodes[term].clock_from = gc.masterClock();
    }
    role.terminal = term;
  }
  const nodes = finalize(gc.nodes);
  if (nodes.length > KNODEPOOL)
    throw new Error(`patch too complex: ${nodes.length} nodes exceeds the ${KNODEPOOL}-slot graph budget (kNodePool). `
                  + `Simplify expressions or factor shared parts.`);
  if (gc.literals.length > KMAXGRAPHLITERALS)
    throw new Error(`patch uses ${gc.literals.length} literal tapes, exceeds ${KMAXGRAPHLITERALS} (kMaxGraphLiterals).`);
  return { nodes, literals: gc.literals, knobSeeds: gc.knobSeeds };
}

const DRIFT_DEFAULT = [-3, -1, 1, 3];
const JACK_SLOTS = ["cv_out_1", "cv_out_2", "audio_out_1", "audio_out_2", "pulse_out_1", "pulse_out_2"];

// Normalize patch to canonical shape: outputs as {jack_or_led: src}, records as [{target, src, clock?}].
function normalizePatch(patch) {
  const outputs = {};
  for (const [k, v] of Object.entries(patch.outputs || {}))
    if (v != null && (typeof v !== "string" || v.trim())) outputs[k] = v;
  // Default led-5: beat blink (shadowed by a patch that binds led_5).
  if (outputs.led_5 === undefined) outputs.led_5 = "(envelope :peak vmid :decay 12)";
  const records = [];
  for (const r of patch.records || []) {
    if (!r || (typeof r === "string" && !r.trim())) continue;
    records.push(r);
  }
  return { ...patch, outputs, records };
}

// Claims pre-pass: expand all roles and resolve anonymous media (delay/tape/audio/record in
// expression position) into concrete tape slots. All sugar; no new runtime primitives.
// Returns canonical shape; records resolve to [{tape, src, clock?}].
function expandAndClaimTapes(patch, env) {
  const defs = { ...(patch.tapes || {}) };
  const used = new Set();
  for (const n of Object.keys(defs)) if (tapeIdx(n) >= 0) used.add(tapeIdx(n));
  for (const r of patch.records) if (typeof r.target === "string" && tapeIdx(r.target) >= 0) used.add(tapeIdx(r.target));
  const claim = (lowFirst, what) => {
    for (let k = 0; k < 8; k++) { const i = lowFirst ? k : 7 - k; if (!used.has(i)) { used.add(i); return i; } }
    throw new Error("(" + what + "): no free tape slot, tape-0..7 all in use (every declared tape, "
                  + "(delay ...), expression (tape ...)/(audio ...) and module instance claims one)");
  };
  const recs = new Map();              // tape index -> {src, clock}: one writer per tape
  const addRec = (name, src, clock) => {
    const i = tapeIdx(name);
    if (recs.has(i))
      throw new Error("(record " + name + " ...): the tape already has a recordhead, one writer per "
                    + "tape (a module that records its own tape can't ALSO be recorded by the consumer)");
    recs.set(i, { src, clock });
  };
  const memo = new Map();              // tree identity -> rewritten tree; shared binding claims once
  const walk = (t) => {
    if (!Array.isArray(t)) return t;
    if (t[0] === "quote" || t[0] === "lens") return t;
    if (memo.has(t)) return memo.get(t);
    const out = t.map(walk);
    let res = out;
    if (out[0] === "delay") {
      const n = Number(out[2]);
      if (!Number.isInteger(n) || n < 1 || n > 96000)
        throw new Error("(delay x N): N must be a literal sample count 1..96000, for a MODULATED "
                      + "delay declare a tape and use (tap tape c :interp), see LOUPE_COOKBOOK.md");
      const k = claim(false, "delay");
      defs["tape-" + k] = { audio: true, length: n + 1 };
      addRec("tape-" + k, out[1]);
      res = ["tap", "tape-" + k, String(n), ...out.slice(3)];
    } else if (out[0] === "tape") {
      const k = claim(true, "tape");
      defs["tape-" + k] = tapeSeed(out, env);
      res = "tape-" + k;
    } else if (out[0] === "audio") {
      const k = claim(false, "audio");
      defs["tape-" + k] = parseAudioArgs(out.slice(1), unparse(t));
      res = "tape-" + k;
    } else if (out[0] === "record") {
      if (!(out.length === 3 || (out.length === 5 && out[3] === ":clk")))
        throw new Error("(record T STREAM [:clk C]) takes a tape and one stream: " + unparse(t));
      if (typeof out[1] !== "string" || tapeIdx(out[1]) < 0)
        throw new Error("(record T ...): T must be a tape, a (tape ...), an (audio ...), or a tape "
                      + "name/port, got " + unparse(t[1]));
      addRec(out[1], out[2], out.length === 5 ? out[4] : undefined);
      res = out[1];
    }
    memo.set(t, res);
    return res;
  };
  const fix = (src) => {
    if (src == null || (typeof src === "string" && !src.trim())) return src;
    return walk(asTree(expandTree(asForm(src), new Map(env))));
  };
  const outputs = Object.fromEntries(Object.entries(patch.outputs).map(([k, v]) => [k, fix(v)]));
  const reset = fix(patch.reset), clock_in = fix(patch.clock_in);
  for (const { target, src, clock } of patch.records) {
    const fclock = clock !== undefined ? fix(clock) : undefined;
    if (typeof target === "string" && tapeIdx(target) >= 0) { addRec(target, fix(src), fclock); continue; }
    const k = fix(target);                               // a tap like (t1 :loop): resolve via the instance
    if (typeof k !== "string" || tapeIdx(k) < 0)
      throw new Error("(record " + unparse(target) + " ...): the target is not a tape or tape port");
    addRec(k, fix(src), fclock);
  }
  return { ...patch, tapes: defs, outputs, reset, clock_in,
           records: [...recs.entries()].map(([tape, r]) => ({ tape, src: r.src, clock: r.clock })) };
}

function compilePatch(patch) {
  const buffer = new Array(BUFFER_BYTES).fill(0);
  const env = baseEnv();                       // (define ...) bindings from the prelude
  if (patch.prelude) parsePrelude(patch.prelude, env);
  const canonical = normalizePatch(patch);
  patch = expandAndClaimTapes(canonical, env);
  const defs = patch.tapes || {};
  const byIdx = []; const tapeLengths = {}; let maxIdx = -1;
  // Sample tapes: volatile audio region [CONTROL_BYTES, BUFFER_BYTES), zeroed at boot.
  let audioNext = CONTROL_BYTES;
  const audioAlloc = (len) => {
    const s = audioNext; audioNext += packedBytes(len);
    if (audioNext > BUFFER_BYTES) throw new Error("audio region exhausted (" + len + " elems, " + (BUFFER_BYTES - s) + " B free)");
    return s;
  };
  // Control tapes: [0, POOL_START), sized by actual packed length (not a fixed slot).
  let ctrlNext = 0;
  const ctrlAlloc = (len) => {
    const s = ctrlNext; ctrlNext += packedBytes(len);
    if (ctrlNext > POOL_START) throw new Error("control-region tapes exhausted (" + len + " elems; [0," + POOL_START + ") holds the sequence tapes, the rest is the literal pool)");
    return s;
  };
  for (const [name, val] of Object.entries(defs)) {
    const idx = tapeIdx(name); if (idx < 0) throw new Error("bad tape name: " + name);
    const arr = Array.isArray(val), bytes = arr ? val : (val.bytes || []);
    const isAudio = !arr && (val.audio || val.seconds !== undefined);
    let length, start, clockDiv;
    if (isAudio) {
      const rate = val.rate ?? 48000;
      clockDiv = Math.max(1, Math.round(48000 / rate));
      length   = val.length ?? Math.round((val.seconds ?? 0) * rate);
      if (length < 1) throw new Error("audio tape " + name + " needs :seconds (or :length)");
      start = audioAlloc(length);
    } else {
      length   = arr ? bytes.length : (val.length ?? bytes.length);
      start    = arr ? ctrlAlloc(length) : (val.start ?? ctrlAlloc(length));
      // clock_div > 0 = fixed-rate region (scope/sampler); 0 = musical (beat x drift).
      clockDiv = arr ? 0 : (val.clock_div ?? (val.rate ? Math.max(1, Math.round(48000 / val.rate)) : 0));
      for (let k = 0; k < length; k++) writeElem(buffer, start, k, bytes.length ? (bytes[k % bytes.length] & 0xFFF) : 0);
    }
    const drift = arr ? (DRIFT_DEFAULT[idx] ?? 0) : (val.drift ?? DRIFT_DEFAULT[idx] ?? 0);
    byIdx[idx] = { start, length, drift, clockDiv, ymod: 0, variety: 128, inputrole: 0 };
    tapeLengths[idx] = length;
    if (idx > maxIdx) maxIdx = idx;
  }
  const tapes = [];
  for (let i = 0; i <= maxIdx; i++)
    tapes.push(byIdx[i] || { start: i * 24, length: 0, drift: DRIFT_DEFAULT[i] ?? 0, clockDiv: 0, ymod: 0, variety: 128, inputrole: 0 });
  const tapeClockDivs = {};
  for (let i = 0; i <= maxIdx; i++) tapeClockDivs[i] = tapes[i].clockDiv || 0;
  const pool = new Pool(buffer, POOL_START);
  const m = patch.master || {};

  const outSrc = ["", "", "", "", "", ""], ledSrc = ["", "", "", "", "", ""];
  for (const [name, expr] of Object.entries(patch.outputs)) {
    if (LEDS[name] !== undefined) ledSrc[LEDS[name]] = expr;
    else if (JACKS[name] !== undefined) outSrc[JACKS[name]] = expr;
    else throw new Error("unknown output: " + name + " (" + Object.keys(JACKS).concat(Object.keys(LEDS)).join("/") + ")");
  }

  for (const e of patch.records)
    if (!(tapes[e.tape] && tapes[e.tape].length > 0))
      throw new Error("(record tape-" + e.tape + " ...): the target tape is not declared, seed it, "
                    + "or declare a sample region: (tape-" + e.tape + " (audio :seconds N))");

  // Role list in schedule order: jacks, LEDs, transport, records.
  const roles = [];
  const rOut = outSrc.map((src, slot) => { const r = { kind: 'output', slot, src }; roles.push(r); return r; });
  const rLed = ledSrc.map((src, slot) => { const r = { kind: 'led', slot, src }; roles.push(r); return r; });
  const rReset   = { kind: 'transport', src: patch.reset || null };
  const rClockIn = { kind: 'transport', src: patch.clock_in || null };
  roles.push(rReset, rClockIn);
  const rRec = patch.records.map(({ tape, src, clock }) => { const r = { kind: 'record', tape, src, clockSrc: clock }; roles.push(r); return r; });

  const graph = compileGraph(roles, tapeLengths, pool, env, tapeClockDivs);

  const terminals = {
    jack: rOut.map(r => r.terminal),
    led:  rLed.map(r => r.terminal),
    reset:    rReset.terminal,
    clock_in: rClockIn.terminal,
    rec:      rRec.map(r => ({ tape: r.tape, terminal: r.terminal })),
  };

  // Knob seeds: :default V wins; else master block; else neutral. Indices 0/1/2 = main/x/y.
  const ks = graph.knobSeeds || {}, inputs = { ...(patch.inputs || {}) };
  if (ks[0] !== undefined) inputs.knob_main = ks[0];
  if (ks[1] !== undefined) inputs.knob_x = ks[1];
  if (ks[2] !== undefined) inputs.knob_y = ks[2];
  const mx = m.x ?? 1024;
  const my = m.y ?? 2048;
  return { buffer, tapes, graph, terminals, master: { x: mx, y: my }, inputs };
}

// Text serialization for the host sim (run.cpp): graph + terminal map.
function serializePatch(p) {
  let o = `buffer ${p.buffer.length}\n${p.buffer.join(" ")}\n`;
  o += `tapes ${p.tapes.length}\n`;
  for (const t of p.tapes) o += `${t.start} ${t.length} ${t.ymod} ${t.variety} ${t.inputrole} ${t.clockDiv}\n`;
  o += `master ${p.master.x} ${p.master.y}\n`;
  const ip = p.inputs || {};
  o += `inputs ${ip.knob_main||0} ${ip.knob_x||0} ${ip.knob_y||0} ` +
       `${ip.master_x ?? p.master.x} ${ip.master_y ?? p.master.y} ` +
       `${ip.cv1||0} ${ip.cv2||0} ${ip.pulse1?1:0} ${ip.pulse2?1:0} ${ip.active_page||0} ${ip.z_switch||0}\n`;
  const nodes = p.graph.nodes, lits = p.graph.literals;
  const P = computeIntervals(nodes);
  o += `graph ${nodes.length} ${lits.length}\n`;
  for (const lit of lits) o += `${lit.start} ${lit.length}\n`;
  nodes.forEach((f, i) =>
    o += `${f.kind} ${f.array_idx} ${f.in_a} ${f.in_b} ${f.param} ${f.param_from} ${f.clock_from} ${f.branch_start} ${f.branch_count} ${f.is_signal | 0} ${wirePeriod(P[i])}\n`);
  const T = p.terminals;
  o += `terminals\n`;
  o += `${T.jack.join(" ")}\n`;
  o += `${T.led.join(" ")}\n`;
  o += `${T.reset} ${T.clock_in}\n`;
  o += `${T.rec.length}\n`;
  for (const r of T.rec) o += `${r.tape} ${r.terminal}\n`;
  return o;
}

// Binary snapshot format is in serialize.js (mirrors snapshot.h). SAVE_VERSION must match kSaveVersion in main.cpp.

// Wrap a bare expression in a default 1-voice patch so the runner always gets a full patch.
function defaultPatch(expr) {
  const arp = [416, 1248, 2080, 2912];   // the boot arpeggio (controller values)
  return { tapes: { "tape-0": arp, "tape-1": arp },
           master: { x: 1024, y: 2048 },
           outputs: { "cv_out_1": expr, "pulse_out_1": "(gate (step tape-0) trig)" } };
}

function unparse(node) {
  return Array.isArray(node) ? "(" + node.map(unparse).join(" ") + ")" : String(node);
}
// Thread source through stages: [a (f x) (g y)] -> (g (f a x) y). Bare atom stage f -> (f acc).
function threadCable(stages) {
  let acc = stages[0];
  for (let i = 1; i < stages.length; i++) {
    const s = stages[i];
    acc = Array.isArray(s) ? [s[0], acc, ...s.slice(1)] : [s, acc];
  }
  return acc;
}
// Parse (<- SINK stage... source [:clk C]). :clk is split off; stages thread right-to-left.
function readConnect(node) {
  let rest = node.slice(1);
  if (!rest.length) throw new Error("(<- SINK source): a connection needs a sink and a source: " + unparse(node));
  const sink = rest[0];
  rest = rest.slice(1);
  let clock;
  const ci = rest.indexOf(":clk");
  if (ci >= 0) {
    clock = rest[ci + 1];
    if (clock === undefined) throw new Error("(<- ... :clk C): :clk needs a clock: " + unparse(node));
    rest = rest.filter((_, k) => k !== ci && k !== ci + 1);
  }
  if (!rest.length) throw new Error("(<- " + unparse(sink) + " ...): nothing to connect: " + unparse(node));
  return { sink, source: threadCable(rest.slice().reverse()), clock };
}
// (morph ctrl s0..sn): crossfade mix; each source gets a tent weight peaking at its slot, summing to VMAX.
function morphTree(a) {
  const [ctrl, ...srcs] = a;
  if (srcs.length < 2) throw new Error("morph needs a control and at least 2 sources");
  const k = srcs.length - 1, seg = Math.round(VMAX / k);
  const terms = srcs.map((src, i) => {
    const pos = String(i * seg);
    const absd = ["add", ["sub", ctrl, pos, ":sat"], ["sub", pos, ctrl, ":sat"]];
    const w    = ["sub", String(VMAX), ["mul", absd, String(k)], ":sat"];
    return ["vca", src, w];
  });
  return ["mix", ...terms];
}
const isQuote = n => Array.isArray(n) && n[0] === "quote";
// Shared arithmetic evaluator for pure integer ops (used by exprTable and evalConst).
// getA/getB are thunks; returns undefined for unknown ops.
function evalArithOp(op, getA, getB) {
  switch (op) {
    case "add": return getA() + getB();
    case "sub": return getA() - getB();
    case "mul": return getA() * getB();
    case "div": { const d = getB(); return d ? Math.trunc(getA() / d) : 0; }
    case "mod": { const d = getB(); return d ? ((getA() % d) + d) % d : 0; }
    case "and":    return getA() & getB();
    case "or":     return getA() | getB();
    case "xor":    return getA() ^ getB();
    case "mask":   return getA() & getB();
    case "invert": return VMAX - getA();
    case "gt": return getA() > getB() ? VMAX : 0;
    case "lt": return getA() < getB() ? VMAX : 0;
    case "eq": return getA() === getB() ? VMAX : 0;
    default: return undefined;
  }
}
// Evaluate a constant numeric expression: numbers, arithmetic, inlined functions. Used by evalSeed.
function evalConst(node, env) {
  if (!Array.isArray(node)) {
    if (env && env.has(node)) { const v = env.get(node); if (!(v && v.__fn)) return evalConst(v, env); }
    const n = parseInt(node, 10);
    if (Number.isNaN(n)) throw new Error("not a constant: " + node);
    return n;
  }
  const A = node.slice(1), E = k => evalConst(A[k], env);
  const r = evalArithOp(node[0], () => E(0), () => E(1));
  if (r !== undefined) return r;
  switch (node[0]) {
    case "hz":  return hzToCutoff(E(0));
    case "khz": return hzToCutoff(E(0) * 1000);
    case "notes": {
      const v = noteValue(A[0]); if (v === null) throw new Error("not a note: " + unparse(A[0])); return v;
    }
    default:
      if (env && env.has(node[0]) && env.get(node[0]).__fn)   // a user function -> inline its body and fold
        return evalConst(expandTree(node, env), env);
      throw new Error("not a constant expression: " + unparse(node));
  }
}
// A quoted list as a plain tape seed: numbers only. Bare symbols in a seed are an error.
function valueList(list, env) {
  return list.map((e) => {
    if (Array.isArray(e))
      throw new Error("a (symbol value) entry needs a lens: (define a (lens '(" + unparse(e) + " ...)))");
    const n = parseInt(e, 10);
    if (Number.isNaN(n))
      throw new Error("symbol '" + e + "' in a bare seed: symbols need a lens, (map notes '(...)) for "
                    + "pitches, or (map L '(...)) through a (lens ...) you define");
    return n & 0xFFF;
  });
}
// Validate a lens: quoted list = value lens; unquoted fn names = op lens. Returns "value" or "op".
function validateLens(L, env) {
  if (L.length < 2) throw new Error("(lens ...) needs entries");
  if (isQuote(L[1])) {
    if (L.length !== 2 || !Array.isArray(L[1][1]))
      throw new Error("a value lens is ONE quoted list: (lens '(tok (tok val) ...))");
    return "value";
  }
  for (const e of L.slice(1)) {
    const b = (typeof e === "string") && env && env.get(e);
    if (!(b && b.__fn))
      throw new Error("(lens " + unparse(e) + " ...): '" + unparse(e) + "' is not a defined function. "
                    + "An op lens references functions (define them first); for data tokens, quote the "
                    + "list: (lens '(...))");
  }
  return "op";
}
// Evaluate a value lens's token list: number -> itself, bare token -> its position, (sym val) -> val.
function lensValues(list, env) {
  return list.map((e, i) => {
    if (Array.isArray(e)) {
      if (e.length !== 2) throw new Error("a (symbol value) entry must have two parts: " + unparse(e));
      return evalConst(e[1], env) & 0xFFF;
    }
    const n = parseInt(e, 10);
    return (Number.isNaN(n) ? i : n) & 0xFFF;
  });
}
// An alphabet: symbol -> position or explicit value; used by (map L '(tokens)).
function alphabet(list, env) {
  const m = new Map();
  list.forEach((e, i) => {
    if (Array.isArray(e)) { if (e.length !== 2) throw new Error("a (symbol value) entry must have two parts: " + unparse(e)); m.set(String(e[0]), evalConst(e[1], env) & 0xFFF); }
    else { const n = parseInt(e, 10); m.set(String(e), (Number.isNaN(n) ? i : n) & 0xFFF); }
  });
  return m;
}
// (score '(NOTE _ ~ ...)): note = onset, _ = hold, ~ = rest. Returns {notes, rhythm} tapes.
function parseScore(node) {
  if (!isQuote(node) || !Array.isArray(node[1]))
    throw new Error("(score '(...)) takes a quoted list of notes, _ (hold) and ~ (rest)");
  // onset=VMAX, hold=VMID, rest=0. Read side: TRIG where rhythm>VMID; GATE where rhythm>0.
  const notes = [], rhythm = []; let prev = 0;
  const HOLD = (VMAX + 1) >> 1;   // VMID
  for (const t of node[1]) {
    if (t === "_") { notes.push(prev); rhythm.push(HOLD); }
    else if (t === "~") { notes.push(prev); rhythm.push(0); }
    else {
      const n = noteValue(t);
      if (n === null) throw new Error("score: expected a note, _ or ~, got " + unparse(t));
      prev = n; notes.push(n & 0xFFF); rhythm.push(VMAX);
    }
  }
  return { notes, rhythm };
}
// Euclidean rhythm: P pulses over S steps, Bresenham spacing, rotated to downbeat.
function euclid(pulses, steps) {
  pulses = Math.max(0, Math.min(pulses, steps));
  const p = []; let acc = 0;
  for (let i = 0; i < steps; i++) { acc += pulses; if (acc >= steps) { acc -= steps; p.push(1); } else p.push(0); }
  const first = p.indexOf(1);
  return first > 0 ? p.slice(first).concat(p.slice(0, first)) : p;
}

// Evaluate a tape-seed expression to a value list, or null if not constant (-> live recordhead).
function evalSeed(node, env) {
  const x = expandTree(node, env);
  if (isQuote(x)) {
    if (!Array.isArray(x[1])) throw new Error("a tape seed must be a quoted LIST: " + unparse(x));
    return valueList(x[1], env);
  }
  if (Array.isArray(x) && x[0] === "euclid") {       // (euclid P S) -> a gate tape
    const pulses = parseInt(x[1], 10), steps = parseInt(x[2], 10);
    if (!(steps > 0)) throw new Error("(euclid P S) needs S > 0");
    return euclid(pulses, steps).map(b => b ? VMAX : 0);
  }
  if (Array.isArray(x) && x[0] === "map") {
    // Encode tokens through a lens into tape bytes; (thru L sel) decodes at runtime.
    if (x.length !== 3) throw new Error("(map L '(...)) takes a lens (or function) and a quoted list");
    const seq = isQuote(x[2]) ? x[2][1] : null;
    if (!Array.isArray(seq)) throw new Error("(map L '(...)): the second argument must be a quoted list");
    let fn = x[1];
    if (typeof fn === "string" && env.has(fn)) { const b = env.get(fn); if (!(b && b.__fn)) fn = b; }
    if (Array.isArray(fn) && fn[0] === "lens") {
      const species = validateLens(fn, env);
      // value lens: token -> value; op lens: token -> index (program-tape encoding).
      const A = (species === "value") ? alphabet(fn[1][1], env)
                                      : new Map(fn.slice(1).map((s, i) => [String(s), i]));
      return seq.map(s => { if (!A.has(String(s))) throw new Error("token '" + s + "' is not in the lens"); return A.get(String(s)) & 0xFFF; });
    }
    if (isQuote(fn))
      throw new Error("(map ...): a raw quoted list is ambiguous, make the vocabulary a lens: (define L (lens " + unparse(fn) + "))");
    const name = x[1];
    if (typeof name !== "string") throw new Error("(map L ...): L must be a lens or a function name");
    return seq.map(e => evalConst([name, String(e)], env) & 0xFFF);
  }
  return null;   // not constant -> a live recordhead source
}

// (use FILE): splice another file's (def ...)s ahead of the patch. .loupe extension implied.
// Default loader uses Node fs; the web UI passes its own (see web/app.js).
// Returns { text, baseDir } for the resolved file, or null if not found.
function defaultUseLoader(baseDir, file) {
  let fs, path;
  try { fs = require("fs"); path = require("path"); } catch (e) { return null; }
  let full = path.resolve(baseDir, file);
  if (!fs.existsSync(full) && fs.existsSync(full + ".loupe")) full += ".loupe";
  if (!fs.existsSync(full)) return null;
  return { text: fs.readFileSync(full, "utf8"), baseDir: path.dirname(full) };
}

function spliceUses(forms, baseDir, loader = defaultUseLoader) {
  const out = [];
  for (const form of forms) {
    if (Array.isArray(form) && form[0] === "use") {
      const file = String(form[1]);
      const got = loader(baseDir, file);
      if (!got) throw new Error("(use " + file + "): not found from " + baseDir
                              + " (in the web UI, only files served alongside patches/ are reachable)");
      const toks = tokenize(got.text); const sub = [];
      while (toks.length) sub.push(read(toks));
      for (const s of spliceUses(sub, got.baseDir, loader)) {
        if (Array.isArray(s) && s[0] === "patch")
          throw new Error("(use " + file + "): a used file is a library of (def ...)s, not a (patch ...)");
        out.push(s);
      }
    } else out.push(form);
  }
  return out;
}

// (tape SEED) or (tape LENS '(tokens)): evaluate to a 12-bit cell list.
function tapeSeed(body, env) {
  const args = body.slice(1);
  let seed;
  if (args.length === 1) seed = evalSeed(args[0], env);
  else if (args.length === 2) seed = evalSeed(["map", args[0], args[1]], env);
  else throw new Error("(tape SEED) or (tape LENS '(tokens)): " + unparse(body));
  if (seed === null)
    throw new Error("(tape ...) needs a constant seed (a quoted list, or LENS '(tokens)); to write a "
                  + "live stream onto a tape, <- into it: " + unparse(body));
  return seed;
}

// Parse a whole patch file: library (def/use)s then exactly one (patch ...).
// Output/record sources stay as source strings; the compiler rebuilds env from prelude.
function parseTextPatch(text, baseDir = ".", loader) {
  const toks = tokenize(text); const forms = [];
  while (toks.length) forms.push(read(toks));
  const top = spliceUses(forms, baseDir, loader);

  const env = baseEnv();
  const patch = { tapes: {}, outputs: {}, records: [] };
  const prelude = [];        // def strings in dependency order, replayed by the compiler

  const used = new Set();
  const allocTape = () => { let i = 0; while (used.has(i)) i++; if (i > 7) throw new Error("out of tapes (tape-0..7)"); used.add(i); return i; };

  // Bind (def NAME thing); tape/score/audio constructors claim a hardware slot now.
  const handleDef = (node) => {
    if (node.length !== 3 || typeof node[1] !== "string") throw new Error("(def NAME thing): " + unparse(node));
    const name = node[1], body = node[2];
    if (Array.isArray(body) && body[0] === "tape") {
      const idx = allocTape(); patch.tapes["tape-" + idx] = tapeSeed(body, env);
      env.set(name, "tape-" + idx); return `(def ${name} tape-${idx})`;
    }
    if (Array.isArray(body) && body[0] === "audio") {
      const idx = allocTape(); patch.tapes["tape-" + idx] = parseAudioArgs(body.slice(1), unparse(body));
      env.set(name, "tape-" + idx); return `(def ${name} tape-${idx})`;
    }
    if (Array.isArray(body) && body[0] === "score") {
      const { notes, rhythm } = parseScore(body[1]);
      const iN = allocTape(); patch.tapes["tape-" + iN] = notes;
      const iR = allocTape(); patch.tapes["tape-" + iR] = rhythm;
      const def = `(def ${name} (outputs (notes tape-${iN}) (rhythm tape-${iR})))`;
      bindDef(read(tokenize(def)), env); return def;
    }
    bindDef(node, env); return unparse(node);
  };

  const tapeOf = (name) => {
    if (typeof name !== "string") return null;
    if (tapeIdx(name) >= 0) return name;
    const b = env.get(name);
    return (typeof b === "string" && tapeIdx(b) >= 0) ? b : null;
  };

  const handleConnect = (node) => {
    const { sink, source, clock } = readConnect(node);
    if (typeof sink === "string") {
      const jack = sink.replace(/-/g, "_");
      if (JACKS[jack] !== undefined || LEDS[jack] !== undefined) {
        if (clock !== undefined) throw new Error("(<- " + sink + " ... :clk C): :clk rides a tape write, not an output");
        patch.outputs[jack] = unparse(source); return;
      }
    }
    const tape = tapeOf(sink);
    if (tape === null)
      throw new Error("(<- " + unparse(sink) + " ...): a sink is a hardware output (audio-out-1, led-0, ...) "
                    + "or a tape (def it first: (def loop (tape '(...))))");
    patch.records.push({ target: tape, src: unparse(source), clock: clock !== undefined ? unparse(clock) : undefined });
  };

  let patchBody = null;
  for (const form of top) {
    if (!Array.isArray(form) || typeof form[0] !== "string") throw new Error("top level: (def ...) or (patch ...), got " + unparse(form));
    if (form[0] === "patch") {
      if (patchBody !== null) throw new Error("a file has exactly one (patch ...)");
      patchBody = form.slice(1);
    } else if (form[0] === "def") { const s = handleDef(form); if (s) prelude.push(s); }
    else throw new Error("top level: expected (def ...) or (patch ...), got (" + form[0] + " ...)");
  }
  if (patchBody === null) throw new Error("a patch file needs one (patch ...)");

  // Pass A: bind all defs (tapes claim slots). Pass B: route all <-.
  for (const st of patchBody) if (Array.isArray(st) && st[0] === "def") { const s = handleDef(st); if (s) prelude.push(s); }
  for (const st of patchBody) {
    if (!Array.isArray(st) || typeof st[0] !== "string") throw new Error("patch body: (def ...) or (<- ...), got " + unparse(st));
    if (st[0] === "def") continue;
    if (st[0] === "<-") { handleConnect(st); continue; }
    throw new Error("patch body: expected (def ...) or (<- ...), got (" + st[0] + " ...)");
  }
  if (prelude.length) patch.prelude = prelude.join("\n");
  return patch;
}

// Load a patch from text: (patch ...) S-expression or bare expression (wrapped in defaultPatch).
function loadPatch(src, baseDir = ".", loader) {
  const s = src.replace(/^(\s*;[^\n]*\n|\s+)*/, "");
  if (s[0] === "{") throw new Error("JSON patches are gone, write a (patch ...) S-expression (see patches/)");
  if (/^\(\s*(def|use|patch)\b/.test(s)) return parseTextPatch(src, baseDir, loader);
  return defaultPatch(src);
}

if (require.main === module) {
  const fs = require('fs');
  const argv = process.argv.slice(2);
  if (argv[0] === '--intervals') {
    let s = argv[1], baseDir = ".";
    if (s && fs.existsSync(s)) { baseDir = require('path').dirname(s); s = fs.readFileSync(s, 'utf8'); }
    s = (s || '').trim();
    const dump = (label, e) => {
      if (!e.nodes.length) return;
      const P = computeIntervals(e.nodes);
      console.log(`\n${label}  (${e.nodes.length} nodes)`);
      e.nodes.forEach((f, i) => console.log(`  [${i}] ${f.kind.padEnd(10)} ${periodLabel(P[i])}`));
    };
    try {
      if (/^\(\s*(def|use|patch)\b/.test(s.replace(/^(\s*;[^\n]*\n|\s+)*/, ""))) {
        const p = compilePatch(loadPatch(s, baseDir));
        dump('graph', p.graph);
      } else {
        dump('expr', compileExpr(s, {}, new Pool(new Array(BUFFER_BYTES).fill(0), POOL_START), baseEnv()));
      }
    } catch (e) { process.stderr.write("interval error: " + e.message + "\n"); process.exit(1); }
    return;
  }
  if (argv[0] === '--desugar') {
    let s = argv[1], baseDir = ".";
    if (s && fs.existsSync(s)) { baseDir = require('path').dirname(s); s = fs.readFileSync(s, 'utf8'); }
    s = (s || fs.readFileSync(0, 'utf8')).trim();
    try {
      const isPatch = /^\(\s*(def|use|patch)\b/.test(s.replace(/^(\s*;[^\n]*\n|\s+)*/, ""));
      if (isPatch) {
        const patch = loadPatch(s, baseDir), env = baseEnv();
        if (patch.prelude) parsePrelude(patch.prelude, env);
        const show = (label, e) => { if (e && String(e).trim()) console.log(`${label}\n  ${unparse(asTree(expandTree(read(tokenize(String(e))), new Map(env))))}`); };
        for (const [jack, e] of Object.entries(patch.outputs || {})) show(jack, e);
        for (const r of patch.records || [])
          show('record ' + (typeof r.target === 'string' ? r.target : unparse(r.target)), r.src);
      } else {
        console.log(unparse(expandTree(read(tokenize(s)), baseEnv())));
      }
    } catch (e) { process.stderr.write("desugar error: " + e.message + "\n"); process.exit(1); }
    return;
  }
  let src = argv[0], baseDir = ".";
  if (src && fs.existsSync(src)) { baseDir = require('path').dirname(src); src = fs.readFileSync(src, 'utf8'); }
  else if (!src) src = fs.readFileSync(0, 'utf8');
  src = src.trim();
  try {
    const patch = loadPatch(src, baseDir);
    if (process.env.LENS_SIM_INPUTS) patch.inputs = JSON.parse(process.env.LENS_SIM_INPUTS);
    process.stdout.write(serializePatch(compilePatch(patch)));
  } catch (e) { process.stderr.write("compile error: " + e.message + "\n"); process.exit(1); }
}
module.exports = { compileExpr, compilePatch, serializePatch, serializeSnapshot, SAVE_VERSION, KIND_ORDER, defaultPatch, parseTextPatch, loadPatch, computeIntervals };
