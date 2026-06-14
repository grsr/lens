// SysEx parser and encoder. Core 1 only. Wire format in lens_sysex.h.

#include "lens_sysex.h"
#include "lens_state.h"

#include "tusb.h"
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

// Core-1 .bss staging buffers (RAM; flash is read-only at runtime).
static uint8_t  rx_buf[LENS_MAX_PACKED];   // inbound message body (between F0/F7)
static uint16_t rx_len    = 0;
static bool     rx_in_msg = false;

static uint8_t  raw_buf[LENS_MAX_SNAPSHOT];    // unpacked snapshot
static uint8_t  out_buf[6 + LENS_MAX_PACKED];  // outbound framed message

// 8-into-7 packing: each group of up to 7 raw bytes -> 1 MSB byte + that many 7-bit bytes.
static size_t pack78(const uint8_t* in, size_t in_len, uint8_t* out)
{
    size_t o = 0;
    size_t i = 0;
    while (i < in_len) {
        size_t group = in_len - i;
        if (group > 7) group = 7;
        uint8_t msb = 0;
        for (size_t k = 0; k < group; ++k) {
            if (in[i + k] & 0x80) msb |= (uint8_t)(1u << k);
        }
        out[o++] = msb;
        for (size_t k = 0; k < group; ++k) {
            out[o++] = (uint8_t)(in[i + k] & 0x7F);
        }
        i += group;
    }
    return o;
}

// Inverse of pack78. Returns raw bytes written, or 0 on destination overrun.
static size_t unpack78(const uint8_t* in, size_t in_len, uint8_t* out, size_t out_cap)
{
    size_t o = 0;
    size_t i = 0;
    while (i < in_len) {
        uint8_t msb = in[i++];
        size_t group = in_len - i;
        if (group > 7) group = 7;
        if (o + group > out_cap) return 0;
        for (size_t k = 0; k < group; ++k) {
            uint8_t b = in[i + k] & 0x7F;
            if (msb & (1u << k)) b |= 0x80;
            out[o + k] = b;
        }
        o += group;
        i += group;
    }
    return o;
}

// ── Outbound helpers ─────────────────────────────────────────
static void send_sysex(const uint8_t* payload, size_t len)
{
    if (!tud_midi_mounted()) return;

    // F0 + 3-byte MFR + payload + F7
    if (len + 5 > sizeof(out_buf)) return;

    out_buf[0] = 0xF0;
    out_buf[1] = LENS_SYSEX_MFR_0;
    out_buf[2] = LENS_SYSEX_MFR_1;
    out_buf[3] = LENS_SYSEX_MFR_2;
    memcpy(&out_buf[4], payload, len);
    out_buf[4 + len] = 0xF7;

    tud_midi_stream_write(0, out_buf, (uint32_t)(len + 5));
}

static void send_ack(uint8_t cmd)
{
    uint8_t p[2] = { LENS_SYSEX_CMD_ACK, cmd };
    send_sysex(p, sizeof(p));
}

static void send_nack(uint8_t cmd, uint8_t reason)
{
    uint8_t p[3] = { LENS_SYSEX_CMD_NACK, cmd, reason };
    send_sysex(p, sizeof(p));
}

static void send_state_dump(void)
{
    size_t snapshot_len = lens_state_snapshot(raw_buf, sizeof(raw_buf));
    if (snapshot_len == 0) {
        send_nack(LENS_SYSEX_CMD_READ_STATE, LENS_SYSEX_NACK_OVERRUN);
        return;
    }
    if (!tud_midi_mounted()) return;

    // F0 MFR STATE_DUMP <8-into-7 packed snapshot> F7
    out_buf[0] = 0xF0;
    out_buf[1] = LENS_SYSEX_MFR_0;
    out_buf[2] = LENS_SYSEX_MFR_1;
    out_buf[3] = LENS_SYSEX_MFR_2;
    out_buf[4] = LENS_SYSEX_CMD_STATE_DUMP;
    size_t n = pack78(raw_buf, snapshot_len, &out_buf[5]);
    out_buf[5 + n] = 0xF7;
    tud_midi_stream_write(0, out_buf, (uint32_t)(6 + n));
}

// ── Inbound dispatch ─────────────────────────────────────────

static void apply_sysex(const uint8_t* body, uint16_t len)
{
    if (len < 4) return;
    if (body[0] != LENS_SYSEX_MFR_0) return;
    if (body[1] != LENS_SYSEX_MFR_1) return;
    if (body[2] != LENS_SYSEX_MFR_2) return;

    const uint8_t cmd = body[3];
    const uint8_t* payload = &body[4];
    const uint16_t payload_len = (uint16_t)(len - 4);

    switch (cmd) {
    case LENS_SYSEX_CMD_PING:
        send_ack(cmd);
        return;

    case LENS_SYSEX_CMD_READ_STATE:
        send_state_dump();
        return;

    case LENS_SYSEX_CMD_READ_PERF: {
        // The perf-probe block is tiny (~70 B raw); reuse raw_buf/out_buf.
        uint8_t cmd_out = LENS_SYSEX_CMD_PERF_DUMP;
        size_t got = lens_perf_read(raw_buf, sizeof(raw_buf));
        if (got == 0) { send_nack(cmd, LENS_SYSEX_NACK_OVERRUN); return; }
        if (!tud_midi_mounted()) return;
        out_buf[0] = 0xF0;
        out_buf[1] = LENS_SYSEX_MFR_0;
        out_buf[2] = LENS_SYSEX_MFR_1;
        out_buf[3] = LENS_SYSEX_MFR_2;
        out_buf[4] = cmd_out;
        size_t n = pack78(raw_buf, got, &out_buf[5]);
        out_buf[5 + n] = 0xF7;
        tud_midi_stream_write(0, out_buf, (uint32_t)(6 + n));
        return;
    }

    case LENS_SYSEX_CMD_WRITE_STATE: {
        size_t got = unpack78(payload, payload_len, raw_buf, sizeof(raw_buf));
        if (got == 0) {
            send_nack(cmd, LENS_SYSEX_NACK_BAD_LENGTH);
            return;
        }
        if (lens_state_busy()) {
            send_nack(cmd, LENS_SYSEX_NACK_BUSY);
            return;
        }
        if (!lens_state_stage(raw_buf, got)) {
            send_nack(cmd, LENS_SYSEX_NACK_BAD_VERSION);
            return;
        }
        send_ack(cmd);
        return;
    }

    case LENS_SYSEX_CMD_SAVE_STATE:
        send_ack(cmd);
        for (int i = 0; i < 32; ++i) tud_task();   // drain ACK before reboot
        lens_state_request_save();      // never returns
        return;

    case LENS_SYSEX_CMD_FACTORY_RESET:
        send_ack(cmd);
        for (int i = 0; i < 32; ++i) tud_task();
        lens_state_factory_reset();     // never returns
        return;

    default:
        send_nack(cmd, LENS_SYSEX_NACK_UNKNOWN_CMD);
        return;
    }
}

static void feed_byte(uint8_t b)
{
    if (b == 0xF0) {
        rx_in_msg = true;
        rx_len    = 0;
    } else if (b == 0xF7) {
        if (rx_in_msg) apply_sysex(rx_buf, rx_len);
        rx_in_msg = false;
        rx_len    = 0;
    } else if (rx_in_msg) {
        if (rx_len < sizeof(rx_buf)) {
            rx_buf[rx_len++] = b;
        } else {
            // Overflow: drop message, resync at next 0xF0.
            rx_in_msg = false;
            rx_len    = 0;
        }
    }
}

// ── Public entry ─────────────────────────────────────────────
void lens_sysex_task(void)
{
    if (!tud_midi_mounted()) return;

    uint8_t in_buf[64];
    while (tud_midi_available()) {
        uint32_t n = tud_midi_stream_read(in_buf, sizeof(in_buf));
        for (uint32_t i = 0; i < n; ++i) feed_byte(in_buf[i]);
    }
}
