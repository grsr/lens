// web/app.js: Lens patch editor UI.
// Inlined by tools/build_web.js after the bundled compiler (global `Lens`)
// and embedded example patches (global `EXAMPLES`).
// Requires a secure context for WebMIDI (https or localhost).
"use strict";

const $ = (id) => document.getElementById(id);
const editor = $("editor"), hl = $("hl"), statusEl = $("status"), picker = $("picker");
const btnConnect = $("connect"), btnSend = $("send"), btnSaveCard = $("savecard");
const btnOpen = $("open"), btnSave = $("save"), filePick = $("filepick");

let midiOut = null, midiIn = null, ackWaiter = null;
let snapshot = null;        // last good compile's bytes

const say = (msg, cls) => { statusEl.textContent = msg; statusEl.className = cls || ""; };

window.addEventListener("error", (e) => say(e.message, "err"));

// ---- syntax highlighting -------------------------------------------------------
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
  return out + "\n";
}

function paint() { try { hl.innerHTML = highlight(editor.value); } catch (_) {} }
const syncScroll = () => { hl.scrollTop = editor.scrollTop; hl.scrollLeft = editor.scrollLeft; };

// (use FILE) loader: fetch patches by URL, cache recursively before compile.
const useCache = new Map();
const scanUses = (t) => { const re = /\(\s*use\s+([^\s)]+)/g, out = []; let m; while ((m = re.exec(t))) out.push(m[1]); return out; };

async function pullUses(relpath) {
  for (const cand of [relpath, relpath + ".loupe"]) {
    const url = new URL("../" + cand, location.href).href;
    if (useCache.has(cand)) return;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const t = await r.text();
      useCache.set(cand, t);
      for (const u of scanUses(t)) await pullUses("patches/" + u);
      return;
    } catch (_) {}
  }
}

// loadFile(relpath): returns text string or null. relpath is repo-root-relative.
// Checks the fetched (use ...) cache, then the files bundled at build time
// (prelude.loupe), so the expander can read the prelude in the browser.
const loadFile = (relpath) => {
  if (useCache.has(relpath)) return useCache.get(relpath);
  if (typeof __LENS_FILES !== "undefined" && __LENS_FILES[relpath]) return __LENS_FILES[relpath];
  return null;
};

async function refresh() {
  try {
    const text = editor.value;
    for (const u of scanUses(text)) await pullUses("patches/" + u);
    const ast        = Lens.read(text);
    const expanded   = Lens.expand(ast, { loadFile });
    const lowered    = Lens.lower(expanded);
    const scheduled  = Lens.schedule(lowered);
    snapshot = Lens.encode(scheduled, lowered);
    const nodeCount = lowered.slots ? lowered.slots.length : 0;
    say(nodeCount + " nodes · " + snapshot.length + " B"
        + (midiOut ? " · " + midiOut.name : " · not connected"), "ok");
  } catch (e) {
    snapshot = null;
    say(e.message, "err");
  }
  btnSend.disabled = btnSaveCard.disabled = !(snapshot && midiOut);
}

function loadText(text) { editor.value = text; paint(); refresh(); }

// ---- WebMIDI ------------------------------------------------------------------
async function connect() {
  if (!navigator.requestMIDIAccess) { say("this browser has no WebMIDI (use Chrome or Edge over http/https, not a file:// page)", "err"); return; }
  try {
    const midi = await navigator.requestMIDIAccess({ sysex: true });
    midiOut = [...midi.outputs.values()].find(p => /lens|workshop|music thing/i.test(p.name)) || null;
    midiIn  = [...midi.inputs.values()].find(p => /lens|workshop|music thing/i.test(p.name)) || null;
    if (!midiOut || !midiIn) { say("no card found (looked for a MIDI device matching lens/workshop/music thing)", "err"); return; }
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

async function saveToCard() {
  if (!snapshot || !midiOut) return;
  btnSaveCard.disabled = true;
  try {
    await writePatch();
    await new Promise(r => setTimeout(r, 700));
    midiOut.send([...Lens.frame(Lens.CMD.SAVE_STATE)]);
    const m = await recv(3000);
    if (m.cmd !== Lens.CMD.ACK) throw new Error("save refused");
    say("saved · card is rebooting, reconnect in a moment", "ok");
    btnConnect.textContent = "connect"; midiOut = midiIn = null;
  } catch (e) { say(e.message, "err"); }
  refresh();
}

// ---- wire up ------------------------------------------------------------------
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

picker.appendChild(new Option("examples…", ""));
for (const name of Object.keys(EXAMPLES)) picker.appendChild(new Option(name, name));
picker.addEventListener("change", () => {
  const text = EXAMPLES[picker.value];
  if (text !== undefined) loadText(text);
});

paint();
refresh();
