// tape.h: Loupe's memory: one 12-bit value buffer, carved into Tape handles.

#pragma once

#include <stdint.h>
#include "value.h"

// Pin audio-rate code to RAM on firmware; no-op on host sim (no pico SDK).
#ifndef __not_in_flash_func
#define __not_in_flash_func(f) f
#endif

namespace loupe {

static constexpr int kControlBytes      = 1024;   // tapes + literal pool: SAVED + freeze-mirrored
static constexpr int kBufferBytes       = 131072; // total torus = 128 KB (power of two for ring mask)
static constexpr int kHardwareRegionEnd = 512;  // sequence tapes live in [0, 512)
static constexpr int kPoolStart         = 512;  // editor-managed pool [512, kControlBytes)

static constexpr int kMaxTapes         = 8;
static constexpr int kDefaultTapeCount = 4;
static constexpr int kDefaultTapeLen   = 16;

// Wrap onto the ring (power-of-two AND). Only address arithmetic touching the buffer.
inline int RingIndex(int addr)
{
    return addr & (kBufferBytes - 1);
}

// 12-bit values packed 2-per-3-bytes:
//   even i: v = b[g] | ((b[g+1] & 0x0F) << 8)
//   odd  i: v = (b[g+1] >> 4) | (b[g+2] << 4)
inline int32_t PackedBytes(int32_t length)
{
    return ((length + 1) >> 1) * 3;
}

inline int32_t ReadElem(const uint8_t* live, int32_t startByte, int32_t i)
{
    int32_t g = startByte + (i >> 1) * 3;
    uint8_t b1 = live[RingIndex(g + 1)];
    if ((i & 1) == 0)
        return (int32_t)(live[RingIndex(g)] | ((b1 & 0x0F) << 8));
    return (int32_t)((b1 >> 4) | (live[RingIndex(g + 2)] << 4));
}

inline void WriteElem(uint8_t* live, int32_t startByte, int32_t i, int32_t v)
{
    v &= 0xFFF;
    int32_t g  = startByte + (i >> 1) * 3;
    int32_t a1 = RingIndex(g + 1);
    if ((i & 1) == 0) {
        live[RingIndex(g)] = (uint8_t)(v & 0xFF);
        live[a1] = (uint8_t)((live[a1] & 0xF0) | ((v >> 8) & 0x0F));
    } else {
        live[a1] = (uint8_t)((live[a1] & 0x0F) | ((v & 0x0F) << 4));
        live[RingIndex(g + 2)] = (uint8_t)((v >> 4) & 0xFF);
    }
}

// Tape-handle namespace for Node.array_idx:
//   0 .. kMaxTapes-1     hardware/named tapes
//   kLiteralBase + n     n-th literal Tape descriptor
static constexpr int kLiteralBase = 32;

struct Tape
{
    // region into the one buffer
    uint32_t start;
    uint32_t length;

    // saved playback / mutation properties
    int8_t  drift_offset;
    uint32_t clock_div;     // 0 = musical clock; >0 = fixed audio/clock_div tick
    bool    y_mod_enabled;
    uint8_t variety_shape;  // TM-mutator distribution
    bool    frozen;         // sticky; gates ALL writers
    uint8_t input_role;

    // saved per-page knob state
    int32_t main_stored;
    int32_t x_stored;
    int32_t y_stored;

    // runtime soft-pickup state (NOT saved)
    int32_t main_snapshot;
    int32_t x_snapshot;
    int32_t y_snapshot;
    bool    main_active;
    bool    x_active;
    bool    y_active;
};

}  // namespace loupe
