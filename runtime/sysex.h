#pragma once
/*
 * Lens on-card sysex receive: parser + pending-apply mechanism.
 *
 * Wire frame: F0 7D 4C 45 <cmd> <payload...> F7
 * Payload uses 8-into-7 packing: every 8 input bytes encode 7 source bytes.
 */

#include <stdint.h>
#include <stddef.h>

namespace lenssysex {

constexpr uint8_t PREFIX[]   = { 0xF0, 0x7D, 0x4C, 0x45 };

/* Command IDs aligned with lens/sysex.js (carried over from prototype). */
constexpr uint8_t CMD_READ_STATE    = 0x01;
constexpr uint8_t CMD_WRITE_STATE   = 0x02;
constexpr uint8_t CMD_SAVE_STATE    = 0x03;
constexpr uint8_t CMD_FACTORY_RESET = 0x04;
constexpr uint8_t CMD_PING          = 0x05;
constexpr uint8_t CMD_READ_PERF     = 0x06;
constexpr uint8_t CMD_DIAG          = 0x07;
constexpr uint8_t CMD_SLOT_PERF     = 0x08;
constexpr uint8_t CMD_SWAP_MODE     = 0x09;  /* 1 payload byte: 0=zero,1=beat,2=bar */
constexpr uint8_t CMD_STATE_DUMP    = 0x10;
constexpr uint8_t CMD_PERF_DUMP     = 0x11;
constexpr uint8_t CMD_DIAG_DUMP     = 0x12;
constexpr uint8_t CMD_SLOT_PERF_DUMP = 0x13;
constexpr uint8_t CMD_ACK           = 0x7F;
constexpr uint8_t CMD_NACK          = 0x7E;

/* NACK reason codes (byte after orig_cmd in NACK payload). */
constexpr uint8_t NACK_BUSY         = 0x01;
constexpr uint8_t NACK_OVERRUN      = 0x02;
constexpr uint8_t NACK_BAD_LENGTH   = 0x03;
constexpr uint8_t NACK_BAD_VERSION  = 0x04;
constexpr uint8_t NACK_UNKNOWN_CMD  = 0x05;

/* 8-into-7: each group of 8 wire bytes decodes to 7 source bytes.
   Worst-case wire payload for 8192 source bytes = ceil(8192/7)*8 = 9368 bytes. */
constexpr size_t SOURCE_CAP  = 8192;
constexpr size_t WIRE_CAP    = ((SOURCE_CAP + 6) / 7) * 8 + 8; /* +8 headroom */

enum class St : uint8_t {
    IDLE,       /* waiting for 0xF0 */
    PRE1,       /* matched F0, waiting for 0x7D */
    PRE2,       /* matched 7D, waiting for 0x4C */
    PRE3,       /* matched 4C, waiting for 0x45 */
    CMD,        /* waiting for command byte */
    PAYLOAD,    /* accumulating payload bytes until 0xF7 */
};

struct ParserState {
    St      state;
    uint8_t cmd;
    uint8_t wire_buf[WIRE_CAP];
    size_t  wire_len;
};

void   init(ParserState* p);
/* Feed one byte. Returns true when a complete F0..F7 frame is in the buffer. */
bool   feed_byte(ParserState* p, uint8_t b);
/* After feed_byte returns true: unpack and write decoded payload into out.
   Returns number of decoded bytes written (0 on decode error). */
size_t get_payload(ParserState* p, uint8_t* out, size_t out_cap);
uint8_t get_command(ParserState* p);

/*
 * Build and send a sysex frame over USB MIDI.
 * cmd: command byte (e.g. CMD_ACK, CMD_PERF_DUMP).
 * payload/len: source bytes; 8-into-7 encoded on the wire.
 * May be called from Core 1 only (TinyUSB stack lives there).
 */
void sysex_send_frame(uint8_t cmd, const uint8_t* payload, size_t len);

/* Send NACK with structured payload: orig_cmd + reason byte. */
void sysex_send_nack(uint8_t orig_cmd, uint8_t reason);

} /* namespace lenssysex */

/* Pending-apply mechanism: Core 1 populates and sets ready; Core 0 consumes. */
struct PendingPatch {
    volatile bool ready;
    uint8_t*      bytes;
    size_t        len;
};

extern PendingPatch g_pending;
