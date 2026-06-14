#!/usr/bin/env node
// build_web.js — assemble compiler modules + example patches + web/app.js into web/index.html.
// WebMIDI requires a secure context (https or localhost). Port filter /lens/i must match usb_descriptors.c.
//
//   node tools/build_web.js          -> web/index.html (also self-tests the bundle)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, "..");
const readSrc = (f) => fs.readFileSync(path.join(ROOT, f), "utf8")
  .replace(/^#![^\n]*\n/, "");   // strip shebangs before inlining into <script>

// Compiler modules bundled as browser-compatible CommonJS; fs/path are stubbed in the shim.
const MODULES = ["reader.js", "nodes.js", "intervals.js", "serialize.js", "compile.js", "sysex.js"];

// Example patches embedded in the page (shown in picker order).
const EXAMPLE_FILES = [
  "patches/hello.loupe",
  "patches/just-a-kick.loupe",
  "patches/vcf.loupe",
  "patches/turing.loupe",
  "patches/meta-turing-machine.loupe",
  "patches/rungler.loupe",
  "patches/dubdelay.loupe",
  "patches/discreet-system.loupe",
];

const shim = `
const __mods = {}, __cache = {};
function __def(name, fn) { __mods[name] = fn; }
function __req(name) {
  if (name === "fs")   return { existsSync: () => false,
                                readFileSync: () => { throw new Error("(use ...) cannot read files in the web loader; paste the module inline"); } };
  if (name === "path") return { resolve: (...a) => a.filter(Boolean).join("/"),
                                dirname: (p) => p.split("/").slice(0, -1).join("/") || ".",
                                basename: (p) => p.split("/").pop(),
                                join: (...a) => a.join("/") };
  const key = name.replace(/^\\.\\.?\\//, "");
  if (!__mods[key]) throw new Error("no module: " + name);
  if (__cache[key]) return __cache[key].exports;
  const m = { exports: {} };
  __cache[key] = m;
  __mods[key](m, m.exports, __req);
  return m.exports;
}`;

const lib = shim + "\n"
  + MODULES.map(f => "__def(" + JSON.stringify(f) + ", function (module, exports, require) {\n"
                   + readSrc(f) + "\n});").join("\n")
  + `\nconst Lens = Object.assign({}, __req("compile.js"), __req("sysex.js"));\n`;

const examples = {};
for (const f of EXAMPLE_FILES) examples[f.replace(/^patches\//, "").replace(/\.loupe$/, "")] = readSrc(f);
const examplesJs = "const EXAMPLES = " + JSON.stringify(examples) + ";\n";

// Self-test: bundled compiler must compile every example.
{
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(lib + "globalThis.__Lens = Lens;", sandbox);
  const L = sandbox.__Lens;
  for (const f of EXAMPLE_FILES) {
    const snap = L.serializeSnapshot(L.compilePatch(L.loadPatch(readSrc(f), path.dirname(path.join(ROOT, f)))));
    console.log("self-test: " + f + " -> " + snap.length + " B snapshot");
  }
}

// Escape "</script" only — a blanket "</" mangling breaks regex literals like /</g.
const esc = (s) => s.replace(/<\/(script)/gi, "<\\/$1");
const starter = examples["hello"];

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lens — patch loader</title>
<style>
  html { background: #14130f; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column;
         color: #d8d2c4; font: 13px/1.45 ui-monospace, Menlo, monospace; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 16px;
           border-bottom: 1px solid #34302a; flex-wrap: wrap; }
  header h1 { font-size: 14px; letter-spacing: .18em; margin: 0 10px 0 0; }
  button, select { background: #2a2720; color: #d8d2c4; border: 1px solid #4a443a;
           border-radius: 5px; padding: 4px 12px; font: inherit; cursor: pointer; }
  button:hover { border-color: #7d7668; }
  button:disabled { opacity: .4; cursor: default; }
  #status { margin-left: auto; color: #7d7668; max-width: 46%; }
  #status.err { color: #e07a5f; }
  #status.ok  { color: #9fd08a; }
  /* editor: transparent textarea over a coloured pre, same metrics */
  main { flex: 1; position: relative; min-height: 0; }
  #hl, #editor { position: absolute; inset: 0; margin: 0; padding: 14px 16px;
                 font: 13px/1.5 ui-monospace, Menlo, monospace; white-space: pre;
                 overflow: auto; tab-size: 2; }
  #hl { background: #191712; color: #d8d2c4; pointer-events: none; }
  #editor { background: transparent; color: transparent; caret-color: #d8d2c4;
            border: 0; outline: none; resize: none; }
  #editor::selection { background: #3a4a5a88; }
  .cmt  { color: #7d7668; }
  .kw   { color: #c8a2d0; }
  .num  { color: #d9b08c; }
  .head { color: #9fd08a; }
  .p0 { color: #8a8474; } .p1 { color: #a89c7e; } .p2 { color: #7e9ca8; }
  .p3 { color: #a87e8a; } .p4 { color: #86a87e; }
  footer { padding: 6px 16px; border-top: 1px solid #34302a; color: #7d7668; }
  footer a { color: #9c9482; }
</style>
<header>
  <h1>LENS</h1>
  <select id="picker"></select>
  <button id="open">open…</button><button id="save">download</button>
  <input id="filepick" type="file" accept=".loupe" style="display:none">
  <button id="connect">connect</button>
  <button id="send" disabled>send</button>
  <button id="savecard" disabled title="writes the patch to the card's flash; the card reboots">save to card</button>
  <span id="status"></span>
</header>
<main>
  <pre id="hl" aria-hidden="true"></pre>
  <textarea id="editor" spellcheck="false" autocomplete="off" autocapitalize="off">${starter.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</textarea>
</main>
<footer>edits compile as you type · send = play it now · save to card = survives power-off · Chrome/Edge only (WebMIDI)</footer>
<script>
  // Surface any error to the status bar.
  window.addEventListener("error", function (e) {
    var s = document.getElementById("status");
    if (s) { s.textContent = "error: " + (e.message || (e.error && e.error.message) || "see console"); s.className = "err"; }
  });
  window.addEventListener("unhandledrejection", function (e) {
    var s = document.getElementById("status");
    if (s) { s.textContent = "error: " + ((e.reason && e.reason.message) || e.reason); s.className = "err"; }
  });
</script>
<script>${esc(lib)}</script>
<script>${esc(examplesJs)}</script>
<script>${esc(readSrc("web/app.js"))}</script>
`;

// Syntax-check each emitted <script> block (runtime ReferenceErrors from DOM globals are fine).
for (const [, body] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  try { new Function(body); }
  catch (e) { if (e instanceof SyntaxError) throw new Error("emitted <script> has a syntax error: " + e.message); }
}

fs.writeFileSync(path.join(ROOT, "web", "index.html"), html);
console.log("built web/index.html (" + (html.length / 1024).toFixed(0) + " KB)");
