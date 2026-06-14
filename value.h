// value.h: the Loupe value domain (12-bit), defined in ONE place.

#pragma once

#include <stdint.h>

namespace loupe {

static constexpr int VBITS  = 12;
static constexpr int VMAX   = (1 << VBITS) - 1;    // 4095
static constexpr int VMID   = 1 << (VBITS - 1);    // 2048   bipolar centre (0 V)
static constexpr int VMASK  = VMAX;                // 0xFFF
static constexpr int SMAX   = VMID - 1;            // 2047   bipolar signal clamp magnitude
static constexpr int UVSHIFT = 1;

using value_t = int16_t;

// Saturate to [0, VMAX].
inline value_t vclamp(int32_t v) { return (value_t)(v < 0 ? 0 : (v > VMAX ? VMAX : v)); }

// Wrap onto the value ring (mod VMAX+1).
inline value_t vwrap(int32_t v) { return (value_t)(v & VMASK); }

// Saturate to bipolar [-SMAX, SMAX].
inline int32_t sclamp(int32_t s) { return s < -SMAX ? -SMAX : (s > SMAX ? SMAX : s); }

// Bipolar bridge (around VMID = 0 V).
inline int32_t v2sig(int32_t v) { return v - VMID; }
inline int32_t sig2v(int32_t s) { return s + VMID; }

// Unipolar bridge: value (0..VMAX) <-> magnitude (0..SMAX).
inline int32_t v2u(int32_t v) { return v >> UVSHIFT; }
inline int32_t u2v(int32_t u) { return u << UVSHIFT; }

}  // namespace loupe
