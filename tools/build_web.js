#!/usr/bin/env node
// tools/build_web.js — assemble compiler modules + example patches + web/app.js
// into a single-file HTML bundle at web/lens.html.
// WebMIDI requires a secure context (https or localhost).
//
//   node tools/build_web.js    -> web/lens.html (also self-tests the bundle)
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT   = path.join(__dirname, "..");
const LENS = ROOT;
const readSrc = (f) => fs.readFileSync(f, "utf8").replace(/^#![^\n]*\n/, "");

// Lens compiler modules — order matters: each require must resolve against an earlier def.
const MODULES = [
  "compiler/reader.js",
  "compiler/expander.js",
  "compiler/op-table.js",
  "compiler/lowerer.js",
  "compiler/scheduler.js",
  "compiler/snapshot.js",
  "compiler/validate.js",
  "cli/sysex.js",
];

// Top-level patches only; utility-pair/ library files are not standalone examples.
const EXAMPLE_FILES = fs.readdirSync(path.join(ROOT, "patches"))
  .filter(f => f.endsWith(".loupe"))
  .sort()
  .map(f => "patches/" + f);

// Browser-compatible CommonJS shim. fs/path stubs so require('fs') and require('path')
// in modules that call them at module load time don't crash. validate.js calls fs lazily
// (only inside validatePreludeKernels(), which is never invoked in the browser).
const shim = `
const __mods = {}, __cache = {};
function __def(name, fn) { __mods[name] = fn; }
function __req(name) {
  if (name === "fs")   return { existsSync: () => false,
                                readFileSync: () => { throw new Error("fs.readFileSync not available in web bundle"); } };
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

// prelude.loupe is loaded by expander.js via loadFile('prelude.loupe').
// In the browser, loadFile reads from __LENS_FILES. Inject both prelude and
// any other files the expander requests at compile time.
const preludeText = readSrc(path.join(ROOT, "prelude.loupe"));
const filesInject = "const __LENS_FILES = " + JSON.stringify({ "prelude.loupe": preludeText }) + ";\n";

// The web loadFile function: checks __LENS_FILES first, then falls back to a
// fetch-populated cache (useCache in app.js). Defined here so modules see it
// before the Lens namespace is assembled.
const loadFileShim = `
function __webLoadFile(relpath) {
  if (__LENS_FILES[relpath]) return __LENS_FILES[relpath];
  return null;
}
`;

const lib = filesInject + shim + "\n" + loadFileShim + "\n"
  + MODULES.map(f => {
      const fullPath = path.join(ROOT, f);
      // Provide __dirname and __filename stubs so modules that reference them at load
      // time (e.g. validate.js) don't throw ReferenceError in the browser sandbox.
      const dirnameStub = "const __dirname = '', __filename = '';\n";
      return "__def(" + JSON.stringify(path.basename(f)) + ", function (module, exports, require) {\n"
           + dirnameStub + readSrc(fullPath) + "\n});";
    }).join("\n")
  + `
const Lens = Object.assign(
  {},
  __req("reader.js"),
  __req("expander.js"),
  __req("lowerer.js"),
  __req("scheduler.js"),
  __req("snapshot.js"),
  __req("validate.js"),
  __req("sysex.js")
);
`;

const examples = {};
for (const f of EXAMPLE_FILES) {
  examples[f.replace(/^patches\//, "").replace(/\.loupe$/, "")] = readSrc(path.join(ROOT, f));
}
const examplesJs = "const EXAMPLES = " + JSON.stringify(examples) + ";\n";

// Self-test: run the bundled pipeline in a vm sandbox on hello.loupe.
{
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(lib + "globalThis.__Lens = Lens;", sandbox);
  const L = sandbox.__Lens;

  // Host-side loadFile so the sandboxed pipeline can read files via real fs.
  const hostLoadFile = (relpath) => {
    const full = path.join(ROOT, relpath);
    if (fs.existsSync(full)) return fs.readFileSync(full, "utf8");
    if (fs.existsSync(full + ".loupe")) return fs.readFileSync(full + ".loupe", "utf8");
    return null;
  };

  for (const f of EXAMPLE_FILES) {
    try {
      const text       = readSrc(path.join(ROOT, f));
      const ast        = L.read(text);
      const expanded   = L.expand(ast, { loadFile: hostLoadFile });
      const lowered    = L.lower(expanded);
      const scheduled  = L.schedule(lowered);
      const snap       = L.encode(scheduled, lowered);
      console.log("self-test: " + f + " -> " + snap.length + " B snapshot");
    } catch (e) {
      console.error("self-test FAIL: " + f + ": " + e.message);
      process.exit(1);
    }
  }

  // Browser-path guard: the editor reads the prelude from the bundled __LENS_FILES,
  // not the filesystem. Compile a note-using patch through that path so a broken
  // prelude injection ships as a build failure, not a dead editor.
  try {
    const webLoad = vm.runInContext("__webLoadFile", sandbox);
    const lowered = L.lower(L.expand(L.read("(patch (<- (cv-out :1) (v-oct C3)))"), { loadFile: webLoad }));
    L.encode(L.schedule(lowered), lowered);
    console.log("self-test: bundled-prelude path resolves note names");
  } catch (e) {
    console.error("self-test FAIL: bundled prelude (__LENS_FILES) not loading: " + e.message);
    process.exit(1);
  }
}

const esc = (s) => s.replace(/<\/(script)/gi, "<\\/$1");
const starter = examples["hello"];

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>'(lens) · patch loader</title>
<link rel="icon" href="lens-logo.svg">
<style>
  html { background: #14130f; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column;
         color: #d8d2c4; font: 13px/1.45 ui-monospace, Menlo, monospace; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 16px;
           border-bottom: 1px solid #34302a; flex-wrap: wrap; }
  header h1 { font-size: 15px; letter-spacing: .02em; margin: 0 10px 0 0; }
  button, select { background: #2a2720; color: #d8d2c4; border: 1px solid #4a443a;
           border-radius: 5px; padding: 4px 12px; font: inherit; cursor: pointer; }
  button:hover { border-color: #7d7668; }
  button:disabled { opacity: .4; cursor: default; }
  #status { margin-left: auto; color: #7d7668; max-width: 46%; }
  #status.err { color: #e07a5f; }
  #status.ok  { color: #9fd08a; }
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
  <h1><span class="num">'</span><span class="cmt">(</span>lens<span class="cmt">)</span></h1>
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
<footer>edits compile as you type &middot; send = play it now &middot; save to card = survives power-off &middot; Chrome/Edge only (WebMIDI) &middot; <a href="https://github.com/grsr/lens/blob/main/docs/loupe.md" target="_blank">loupe docs</a></footer>
<script>
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
<script>${esc(readSrc(path.join(LENS, "web", "app.js")))}</script>
`;

for (const [, body] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  try { new Function(body); }
  catch (e) { if (e instanceof SyntaxError) throw new Error("emitted <script> has a syntax error: " + e.message); }
}

// Write lens.html and an index.html copy so a GitHub Pages folder URL
// (.../web/) serves the editor directly.
for (const name of ["lens.html", "index.html"]) {
  fs.writeFileSync(path.join(ROOT, "web", name), html);
}
console.log("built web/lens.html + web/index.html (" + (html.length / 1024).toFixed(0) + " KB)");

// Publish an always-current, syntax-highlighted copy of the prelude as a docs page.
// Generated from prelude.loupe so the docs site never drifts from the real environment.
const preludeBody = preludeText.endsWith("\n") ? preludeText : preludeText + "\n";
const preludeDoc = `---
title: prelude
description: The standard environment every patch starts with.
---

<!-- generated from prelude.loupe by tools/build_web.js; do not edit by hand -->

# Prelude

\`prelude.loupe\` is the standard environment every patch starts with: constants, pitch
names, helper functions, the builtin op surface, scales, chords, rhythms, and pattern
builders. Every definition here can be shadowed by redefining it in your own patch.

\`\`\`clojure
${preludeBody}\`\`\`
`;
fs.writeFileSync(path.join(ROOT, "docs", "prelude.md"), preludeDoc);
console.log("built docs/prelude.md from prelude.loupe");
