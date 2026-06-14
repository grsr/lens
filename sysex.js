// sysex.js: SysEx wire layer (8-into-7 packing + framing). Mirrors lens_sysex.cpp/.h.
'use strict';

const MFR = [0x7D, 0x4C, 0x45];   // educational manufacturer id + 'L' 'E'

const CMD = {
  READ_STATE:    0x01,
  WRITE_STATE:   0x02,
  SAVE_STATE:    0x03,
  FACTORY_RESET: 0x04,
  PING:          0x05,
  READ_PERF:     0x06,
  STATE_DUMP:    0x10,
  PERF_DUMP:     0x11,
  ACK:           0x7F,
  NACK:          0x7E,
};

// 8-into-7: groups of up to 7 bytes -> 1 MSB byte + 7 low-bit bytes.
function pack78(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 7) {
    const group = raw.slice(i, i + 7);
    let msb = 0;
    for (let k = 0; k < group.length; k++) if (group[k] & 0x80) msb |= (1 << k);
    out.push(msb);
    for (let k = 0; k < group.length; k++) out.push(group[k] & 0x7F);
  }
  return Uint8Array.from(out);
}

function unpack78(p) {
  const out = [];
  let i = 0;
  while (i < p.length) {
    const msb = p[i++];
    const group = Math.min(7, p.length - i);
    for (let k = 0; k < group; k++) {
      let b = p[i + k] & 0x7F;
      if (msb & (1 << k)) b |= 0x80;
      out.push(b);
    }
    i += group;
  }
  return Uint8Array.from(out);
}

// F0 7D 4C 45 <cmd> <packed payload> F7.
function frame(cmd, rawPayload) {
  const packed = rawPayload && rawPayload.length ? pack78(rawPayload) : [];
  return Uint8Array.from([0xF0, ...MFR, cmd, ...packed, 0xF7]);
}

// Returns { cmd, payload } (unpacked) or null.
function parse(msg) {
  if (msg.length < 6 || msg[0] !== 0xF0 || msg[msg.length - 1] !== 0xF7) return null;
  if (msg[1] !== MFR[0] || msg[2] !== MFR[1] || msg[3] !== MFR[2]) return null;
  const cmd = msg[4];
  const packed = msg.slice(5, msg.length - 1);
  return { cmd, payload: unpack78(packed) };
}

module.exports = { MFR, CMD, pack78, unpack78, frame, parse };
