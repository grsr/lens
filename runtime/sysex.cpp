/*
 * Lens sysex receive parser + 8-into-7 decoder + frame sender.
 * No malloc; all buffers are static.
 */

#include "sysex.h"
#include "tusb.h"
#include <string.h>

namespace lenssysex {

void init(ParserState* p) {
    p->state    = St::IDLE;
    p->cmd      = 0;
    p->wire_len = 0;
}

bool feed_byte(ParserState* p, uint8_t b) {
    switch (p->state) {
    case St::IDLE:
        if (b == 0xF0) { p->state = St::PRE1; p->wire_len = 0; }
        return false;
    case St::PRE1:
        p->state = (b == 0x7D) ? St::PRE2 : St::IDLE;
        return false;
    case St::PRE2:
        p->state = (b == 0x4C) ? St::PRE3 : St::IDLE;
        return false;
    case St::PRE3:
        p->state = (b == 0x45) ? St::CMD : St::IDLE;
        return false;
    case St::CMD:
        p->cmd   = b;
        p->state = St::PAYLOAD;
        return false;
    case St::PAYLOAD:
        if (b == 0xF7) {
            p->state = St::IDLE;
            return true;
        }
        /* Discard if overrun; keep state machine alive. */
        if (p->wire_len < WIRE_CAP)
            p->wire_buf[p->wire_len++] = b;
        return false;
    }
    return false;
}

/*
 * 8-into-7 decode.
 *
 * Each group of 8 wire bytes encodes 7 source bytes:
 *   wire[0] holds the high bits: bit k -> bit 7 of out[k]  for k in 0..6.
 *   wire[1..7] hold the low 7 bits of out[0..6].
 *
 * A trailing partial group is valid: k wire bytes (1 <= k <= 8) encode k-1 source bytes.
 * (A lone high-bits byte with no data bytes encodes nothing; k==1 yields 0 source bytes.)
 */
size_t get_payload(ParserState* p, uint8_t* out, size_t out_cap) {
    const uint8_t* src = p->wire_buf;
    size_t         rem = p->wire_len;
    size_t         n   = 0;

    while (rem >= 1) {
        size_t group = rem < 8 ? rem : 8;
        uint8_t hi   = src[0];
        size_t  data = group - 1; /* number of source bytes from this group */

        if (n + data > out_cap) return 0; /* output overflow */

        for (size_t i = 0; i < data; i++) {
            uint8_t lo  = src[1 + i];
            uint8_t msb = (hi >> i) & 1u;
            out[n++] = lo | (uint8_t)(msb << 7);
        }

        src += group;
        rem -= group;
    }

    return n;
}

uint8_t get_command(ParserState* p) {
    return p->cmd;
}

/*
 * 8-into-7 encode (inverse of get_payload).
 *
 * Each group of 7 source bytes encodes 8 wire bytes:
 *   wire[0] = high bits: bit k <- bit 7 of src[k]  for k in 0..6.
 *   wire[1..7] = low 7 bits of src[0..6].
 * A trailing partial group of k source bytes (1<=k<=7) encodes k+1 wire bytes.
 */
static size_t pack78(const uint8_t* src, size_t src_len, uint8_t* dst) {
    size_t out = 0;
    while (src_len > 0) {
        size_t group = src_len < 7 ? src_len : 7;
        uint8_t hi = 0;
        for (size_t i = 0; i < group; i++)
            hi |= (uint8_t)(((src[i] >> 7) & 1u) << i);
        dst[out++] = hi;
        for (size_t i = 0; i < group; i++)
            dst[out++] = src[i] & 0x7Fu;
        src     += group;
        src_len -= group;
    }
    return out;
}

/* Send a NACK frame: F0 7D 4C 45 CMD_NACK <orig_cmd> <reason> F7 */
void sysex_send_nack(uint8_t orig_cmd, uint8_t reason) {
    uint8_t body[2] = { orig_cmd, reason };
    sysex_send_frame(CMD_NACK, body, 2);
}

void sysex_send_frame(uint8_t cmd, const uint8_t* payload, size_t len) {
    /*
     * Build wire bytes directly into one static buffer:
     *   F0 7D 4C 45 cmd <pack78(payload)> F7
     * Sized for the largest payload we send (snapshot + slot-perf).
     */
    const size_t HDR = 5;
    static uint8_t raw[HDR + WIRE_CAP + 1];
    raw[0] = 0xF0;
    raw[1] = 0x7D;
    raw[2] = 0x4C;
    raw[3] = 0x45;
    raw[4] = cmd;

    size_t wire_len = 0;
    if (len > 0 && len <= SOURCE_CAP) {
        wire_len = pack78(payload, len, raw + HDR);
    }
    raw[HDR + wire_len] = 0xF7;
    const size_t raw_len = HDR + wire_len + 1;

    /* Packetise into 3-data-byte USB MIDI packets. */
    size_t pos = 0;
    while (pos < raw_len) {
        size_t left = raw_len - pos;
        uint8_t pkt[4] = { 0, 0, 0, 0 };
        if (left >= 3) {
            bool is_end = (pos + 3 == raw_len);
            if (is_end) {
                /* Last 3 bytes — check if F7 is at position pos+2 */
                pkt[0] = 0x07; /* sysex end, 3 bytes */
            } else {
                pkt[0] = 0x04; /* sysex continue */
            }
            pkt[1] = raw[pos];
            pkt[2] = raw[pos + 1];
            pkt[3] = raw[pos + 2];
            pos += 3;
        } else if (left == 2) {
            pkt[0] = 0x06; /* sysex end, 2 bytes */
            pkt[1] = raw[pos];
            pkt[2] = raw[pos + 1];
            pos += 2;
        } else { /* left == 1 */
            pkt[0] = 0x05; /* sysex end, 1 byte */
            pkt[1] = raw[pos];
            pos += 1;
        }
        tud_midi_packet_write(pkt);
    }
}

} /* namespace lenssysex */

/* Definition of the global pending-apply slot and its static backing buffer. */
static uint8_t s_pending_buf[lenssysex::SOURCE_CAP];
PendingPatch g_pending = { false, s_pending_buf, 0 };
