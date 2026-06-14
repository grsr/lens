// web/app.js — the Lens patch loader: pick or edit a Loupe patch, ship it to the card
// over WebMIDI SysEx. BROWSER code, inlined by tools/build_web.js after the bundled
// compiler (global `Lens`) and the embedded example patches (global `EXAMPLES`).
// Deliberately minimal: an editor, a picker, connect / send / save. The text is the patch.
//
// Note: top-level names avoid the legacy window globals (status, name, length, ...);
// a classic <script> that declares `const status` is rejected whole by some browsers.
"use strict";

const $ = (id) => document.getElementById(id);
const editor = $("editor"), hl = $("hl"), statusEl = $("status"), picker = $("picker");
const btnConnect = $("connect"), btnSend = $("send"), btnSaveCard = $("savecard");
const btnOpen = $("open"), btnSave = $("save"), filePick = $("filepick");

let midiOut = null, midiIn = null, ackWaiter = null;
let snapshot = null;        // last good compile's bytes

const say = (msg, cls) => { statusEl.textContent = msg; statusEl.className = cls || ""; };

// Surface any uncaught error to the status bar rather than dying silently.
window.addEventListener("error", (e) => say(e.message, "err"));

// ---- syntax highlighting -------------------------------------------------------------
// A transparent textarea over a coloured <pre>, kept in sync on input and scroll. No
// editor library: Loupe is a tiny lisp, one regex pass covers it (comments, :keywords,
// numbers, form heads, parens by depth). Highlighting is cosmetic, so it never throws
// up the stack: a failure just leaves the previous paint in place.
const TOKEN = /(;[^\n]*)|(:[\w?*+-]+)|(\(|\))|(-?\d[\w.]*)|([^\s();]+)|(\s+)/g;
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function highlight(src) {
  let out = "", depth = 0, head = false, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src))) {
    const [, cmt, kw, paren, num, sym, ws] = m;
    if (cmt)      { out += '<span class="cmt">' + escHtml(cmt) + "</span>"; head = false; }
    else if (kw)  { out += '<span class="kw">' + escHtml(kw) + "</span>"; head = false; }
    else if (paren) {
      if (paren === "(") { out += '<span class="p' + (depth % 5) + '">(</span>'; depth++; head = true; }
      else { depth = Math.max(0, depth - 1); out += '<span class="p' + (depth % 5) + '">)</span>'; head = false; }
    }
    else if (num) { out += '<span class="num">' + escHtml(num) + "</span>"; head = false; }
    else if (sym) { out += head ? '<span class="head">' + escHtml(sym) + "</span>" : escHtml(sym); head = false; }
    else out += ws;
  }
  return out + "\n";    // trailing newline keeps the pre and textarea the same height
}

function paint() { try { hl.innerHTML = highlight(editor.value); } catch (_) {} }
const syncScroll = () => { hl.scrollTop = editor.scrollTop; hl.scrollLeft = editor.scrollLeft; };

// (use FILE) loader: same-origin fetch from patches/. Pre-fetches every reference
// (recursive) before compile, so spliceUses can stay synchronous.
const useCache = new Map();    // URL -> text
const scanUses = (t) => { const re = /\(\s*use\s+([^\s)]+)/g, out = []; let m; while ((m = re.exec(t))) out.push(m[1]); return out; };
const dirOf = (url) => { const i = url.lastIndexOf("/"); return i < 0 ? "" : url.slice(0, i); };

async function pullUses(baseDir, file) {
  for (const cand of [file, file + ".loupe"]) {
    const url = new URL(baseDir + "/" + cand, location.href).href;
    if (useCache.has(url)) return;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const t = await r.text();
      useCache.set(url, t);
      for (const u of scanUses(t)) await pullUses(dirOf(url), u);
      return;
    } catch (_) {}
  }
}

const useLoader = (baseDir, file) => {
  for (const cand of [file, file + ".loupe"]) {
    const url = new URL(baseDir + "/" + cand, location.href).href;
    if (useCache.has(url)) return { text: useCache.get(url), baseDir: dirOf(url) };
  }
  return null;
};

async function refresh() {
  try {
    const text = editor.value;
    for (const u of scanUses(text)) await pullUses("../patches", u);
    const compiled = Lens.compilePatch(Lens.loadPatch(text, "../patches", useLoader));
    snapshot = Lens.serializeSnapshot(compiled);
    say(compiled.graph.nodes.length + " nodes · " + snapshot.length + " B"
        + (midiOut ? " · " + midiOut.name : " · not connected"), "ok");
  } catch (e) {
    snapshot = null;
    say(e.message, "err");    // the compiler's error text IS the documentation
  }
  btnSend.disabled = btnSaveCard.disabled = !(snapshot && midiOut);
}

function loadText(text) { editor.value = text; paint(); refresh(); }

// ---- WebMIDI ---------------------------------------------------------------------------
async function connect() {
  if (!navigator.requestMIDIAccess) { say("this browser has no WebMIDI (use Chrome or Edge over http/https, not a file:// page)", "err"); return; }
  try {
    const midi = await navigator.requestMIDIAccess({ sysex: true });
    midiOut = [...midi.outputs.values()].find(p => /lens/i.test(p.name)) || null;
    midiIn  = [...midi.inputs.values()].find(p => /lens/i.test(p.name)) || null;
    if (!midiOut || !midiIn) { say("no card found (looked for a MIDI device named 'Lens')", "err"); return; }
    midiIn.onmidimessage = (ev) => {
      const m = Lens.parse([...ev.data]);
      if (m && ackWaiter) { const w = ackWaiter; ackWaiter = null; w(m); }
    };
    btnConnect.textContent = "connected";
    refresh();
  } catch (e) { say("midi: " + e.message, "err"); }
}

const recv = (ms = 1500) => new Promise((res, rej) => {
  const t = setTimeout(() => { ackWaiter = null; rej(new Error("no reply from the card")); }, ms);
  ackWaiter = (m) => { clearTimeout(t); res(m); };
});

// WRITE_STATE with retry-on-busy, mirroring cli.js: the card NACKs (busy) while a
// previous patch waits for its quiet apply moment; back off a beat and resend.
async function writePatch() {
  for (let t = 0; t < 4; t++) {
    midiOut.send([...Lens.frame(Lens.CMD.WRITE_STATE, snapshot)]);
    const m = await recv();
    if (m.cmd === Lens.CMD.ACK) return;
    if (m.cmd === Lens.CMD.NACK && m.payload[1] === 0x06) { await new Promise(r => setTimeout(r, 150)); continue; }
    throw new Error("card refused the patch (NACK " + (m.payload[1] || "?") + ")");
  }
  throw new Error("card stayed busy");
}

async function send() {
  if (!snapshot || !midiOut) return;
  btnSend.disabled = true;
  try { await writePatch(); say("sent · playing", "ok"); }
  catch (e) { say(e.message, "err"); }
  btnSend.disabled = !(snapshot && midiOut);
}

// Save = send, then SAVE_STATE: the card writes flash and REBOOTS (the USB device drops
// and re-enumerates; reconnect after).
async function saveToCard() {
  if (!snapshot || !midiOut) return;
  btnSaveCard.disabled = true;
  try {
    await writePatch();
    await new Promise(r => setTimeout(r, 700));        // let the quiet-moment apply land first
    midiOut.send([...Lens.frame(Lens.CMD.SAVE_STATE)]);
    const m = await recv(3000);
    if (m.cmd !== Lens.CMD.ACK) throw new Error("save refused");
    say("saved · card is rebooting — reconnect in a moment", "ok");
    btnConnect.textContent = "connect"; midiOut = midiIn = null;
  } catch (e) { say(e.message, "err"); }
  refresh();
}

// ---- wire up the page (listeners FIRST, so nothing below can leave a dead button) ------
let timer = null;
editor.addEventListener("input", () => { paint(); clearTimeout(timer); timer = setTimeout(refresh, 250); });
editor.addEventListener("scroll", syncScroll);
btnConnect.addEventListener("click", connect);
btnSend.addEventListener("click", send);
btnSaveCard.addEventListener("click", saveToCard);
btnOpen.addEventListener("click", () => filePick.click());
filePick.addEventListener("change", () => {
  const f = filePick.files[0]; if (!f) return;
  f.text().then(t => { picker.value = ""; loadText(t); });
});
btnSave.addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([editor.value], { type: "text/plain" }));
  a.download = (picker.value || "patch").replace(/.*\//, "").replace(/\.loupe$/, "") + ".loupe";
  a.click();
});

// the example picker: a leading "examples…" placeholder, then every embedded patch
picker.appendChild(new Option("examples…", ""));
for (const name of Object.keys(EXAMPLES)) picker.appendChild(new Option(name, name));
picker.addEventListener("change", () => {
  const text = EXAMPLES[picker.value];
  if (text !== undefined) loadText(text);
});

paint();
refresh();
