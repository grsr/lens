/*
 * runtime.c — merged audio runtime.
 *
 * Each op_* is a real function (not static inline) decorated with OP_FN
 * so the linker places it in RAM, not flash.  Taking the address of each
 * op_* for KFN[] prevents the compiler from inlining them.  LTO is off.
 *
 * Dispatch at run time: s->fn is set to KFN[kernel_id] at apply time;
 * each walk step calls (*s->fn)(s) — one indirect BLX, no switch.
 *
 * KTABLE (name -> KID) lives here; snapshot_apply.c calls
 * runtime_find_kernel() / runtime_is_hw_leaf().
 */

#include "runtime.h"
#include "kernel_ids.h"
#include "pitch_table.h"
#include "rate_table.h"
#include "sine_table.h"
#include <stdint.h>
#include <string.h>

/* ===== arith state structs ===== */


/* ===== stateful state structs ===== */

/*
 * NodeState layout (stateful kernels only):
 *   offset 0: int32_t value  -- output, written and read each sample
 *   offset 4+: kernel-specific fields
 *
 * The slot's `out` pointer aims at &value. Kernels cast it to their state
 * struct and write to state->value each sample.
 */

struct NodeStateBase {
    int32_t value;
};

struct LeafState {
    int32_t value;
};

struct PhasorState {
    int32_t value;        /* +0  phase ramp output (0..VMAX) */
    int32_t tick;         /* +4  unused second-output slot (consumers edge-detect +0) */
    uint32_t phase;
    int32_t last_sync;
    uint32_t sync_count;
    uint32_t locked_inc;
};

struct SineState {
    int32_t value;
    uint32_t phase;
};

struct TriangleState {
    int32_t value;
    uint32_t phase;
};

/* DPW band-limited saw (Valimaki 2005, after Chris Johnson's Utility-Pair card). */
struct SawState {
    int32_t value;
    uint32_t phase;
    int32_t last_parab;
};

/* DPW square = saw(phase) - saw(phase + half-period). */
struct SquareState {
    int32_t value;
    uint32_t phase;
    int32_t last_parab_a;
    int32_t last_parab_b;
};

struct EdgeState {
    int32_t value;
    int32_t last;
    int32_t pulse;
};

struct FallState {
    int32_t value;
    int32_t last;
    int32_t pulse;
};

struct DiffState {
    int32_t value;
    int32_t last;
};

struct ToggleState {
    int32_t value;
    int32_t last;
    int32_t state;
};

struct HoldState {
    int32_t value;
    int32_t last;
};

struct GateState {
    int32_t value;
    int32_t last;
    int32_t hold_count;
};

struct SchmittState {
    int32_t value;
    int32_t last;
};


struct Z1State {
    int32_t value;
    int32_t last;
};

struct EveryState {
    int32_t value;
    int32_t last_clk;
    int32_t counter;
    int32_t pulse;
};

struct EuclidState {
    int32_t value;
    int32_t last_clk;
    int32_t counter;
    int32_t pulse;
};

/* turns: rising-edge counter, wraps at VMAX+1. */
struct TurnsState {
    int32_t value;
    int32_t last_clk;
    int32_t count;
};

/* counter: bar counter wrapping at :bars. */
struct CounterState {
    int32_t value;
    int32_t last_clk;
    int32_t count;
};

/* ===== filter state structs ===== */

/*
 * One-pole IIR state stored in Q16 (int32, range +-268M fits in int32).
 * Integer part: y_q16 >> 16.  Output: round16(y_q16).
 * Coefficient: k = cut * 16  (= cut/4096 * 65536; VMAX~4096 avoids division).
 * Step: y_q16 += (x - (y_q16 >> 16)) * k
 * Output: round16(y_q16) = (y_q16 + 32768) >> 16  (with sign-correct rounding)
 */

struct OnePoleState {
    int32_t value;
    int32_t y_q16;
};

/* VCF: 2-pole state-variable (Chamberlin SVF); lp and bp in Q16. */
struct VcfState {
    int32_t value;
    int32_t lp_q16;
    int32_t bp_q16;
};

/* Noise: white noise via LCG.  Initial rng = 12345 (matches interp.js). */
struct NoiseState {
    int32_t value;
    uint32_t rng;
};

/* Random: clocked random.  Initial rng = 99991, cached = VMID. */
struct RandomState {
    int32_t value;
    uint32_t rng;
    int32_t  last_clk;
    int32_t  cached_value;
};

/* Chance: probability gate.  Initial rng = 77771, cached = 0. */
struct ChanceState {
    int32_t value;
    uint32_t rng;
    int32_t  last_clk;
    int32_t  cached_value;
};

/* Walk: drunken walk.  Initial rng = 55551, cached = VMID.
   param0 = step size (default 128). */
struct WalkState {
    int32_t value;
    uint32_t rng;
    int32_t  last_clk;
    int32_t  cached_value;
};

/* LPG: one-pole LP + VCA combined.
   in0 = signal, in1 = ctrl 0..VMAX.
   State y_q16 is the LP accumulator (Q16). */
struct LpgState {
    int32_t value;
    int32_t y_q16;
};

/* EnvFollow: full-wave rectify then one-pole LP.
   in0 = signal, in1 = cut coefficient. */
struct EnvFollowState {
    int32_t value;
    int32_t y_q16;
};

/* Wavefold: ADAA wavefolder.
   After Chris Johnson's Utility-Pair card.
   State: lastx (int32), lastval (int32). */
struct WavefoldState {
    int32_t value;
    int32_t lastx;
    int32_t lastval;
};

/* Crush: sample-rate decimator.
   in0 = signal, in1 = rate (higher = less crushing).
   N = max(1, round((VMAX - rate) / 100) + 1).
   State: held value, countdown. */
struct CrushState {
    int32_t value;
    int32_t held;
    int32_t count;
};

/* ===== drum state structs ===== */

/* Drum voices after Mutable Instruments Plaits (Emilie Gillet, MIT).
 * Reimplemented for the 12-bit Loupe runtime. Numerics per heritage-kernels.md. */

struct KickState {
    int32_t value;
    int32_t level;
    int32_t last_trig;
    int32_t pitchEnv;
    uint32_t phase;
    int32_t lp;
    int32_t hp;
    int32_t cached_decay;
    int32_t cached_k;
};

struct SnareState {
    int32_t value;
    int32_t level;
    int32_t last_trig;
    int32_t pitchEnv;
    uint32_t phase;
    uint32_t pos;
    uint32_t rng;
    int32_t lp1;
    int32_t lp2;
    int32_t cached_decay;
    int32_t cached_k;
};

struct HatState {
    int32_t value;
    int32_t level;
    int32_t last_trig;
    uint32_t p1;
    uint32_t p2;
    uint32_t p3;
    int32_t hp;
    int32_t cached_decay;
    int32_t cached_k;
};

/* ===== voice state structs ===== */

struct EnvelopeState {
    int32_t value;
    int32_t level;
    int32_t last_trig;
    int32_t cached_decay;
    int32_t cached_k;
};

struct FollowState {
    int32_t  value;       /* +0  phase ramp (0..VMAX) */
    int32_t  tick;        /* +4  unused second-output slot (consumers edge-detect +0) */
    uint32_t last_base;   /* base clock's 12-bit ramp last sample (turn detect) */
    uint32_t counter;     /* base turns elapsed, mod div */
    uint32_t acc;         /* accumulated :drift phase creep (32-bit, >>20 to 12) */
};

/* ===== tape state structs ===== */

/*
 * Buffer: shared ring-buffer, cells 12-bit packed (2 per 3 bytes).
 * Each recordhead tracks its own position.
 * Byte storage: (length * 3 + 1) >> 1 bytes.
 */

struct StepState {
    int32_t value;
    int32_t last_clk;
    int32_t counter;
    int32_t cached;
};

struct LookupState {
    int32_t value;
};

struct WaveState {
    int32_t value;
};

struct TapState {
    int32_t value;
};

/* Record-head positions are 32-bit so a per-sample (audio) head can address the
 * whole audio pool (~87381 cells = 1.82 s). The ring wraps by compare-and-
 * subtract, so the buffer length need not be a power of two. head_pos_out at
 * +4 is the published head op_tap reads (TAG_SLOT_OUT2). */
struct RecordheadPerSampleState {
    int32_t  value;
    int32_t  head_pos_out;
    uint32_t head_pos;
    uint32_t pending_pos;
    int32_t  pending_val;
    uint32_t pending_head_pos_next;
    uint8_t  pending_valid;
    uint8_t  _pad[3];
};

struct RecordheadPerCellState {
    int32_t  value;
    int32_t  head_pos_out;
    uint32_t head_pos;
    uint32_t pending_pos;
    int32_t  pending_val;
    uint32_t pending_head_pos_next;
    uint8_t  pending_valid;
    uint8_t  _pad[3];
    int32_t  last_clk;
};

struct RecordheadGatedState {
    int32_t  value;
    int32_t  head_pos_out;
    uint32_t head_pos;
    uint32_t pending_pos;
    int32_t  pending_val;
    uint32_t pending_head_pos_next;
    uint8_t  pending_valid;
    uint8_t  _pad[3];
    int32_t  last_clk;
};

struct RecordheadLenCappedState {
    int32_t  value;
    int32_t  head_pos_out;
    uint32_t head_pos;
    uint32_t pending_pos;
    int32_t  pending_val;
    uint32_t pending_head_pos_next;
    uint8_t  pending_valid;
    uint8_t  _pad[3];
    int32_t  last_clk;
};

struct RecordheadLenCappedGatedState {
    int32_t  value;
    int32_t  head_pos_out;
    uint32_t head_pos;
    uint32_t pending_pos;
    int32_t  pending_val;
    uint32_t pending_head_pos_next;
    uint8_t  pending_valid;
    uint8_t  _pad[3];
    int32_t  last_clk;
};

struct SeekState {
    int32_t value;
};

struct OnsetsState {
    int32_t value;
    int32_t last_clk;
    int32_t counter;
    int32_t pulseLeft;
};

struct GatesState {
    int32_t value;
    int32_t last_clk;
    int32_t counter;
    int32_t gate;
};

struct HitsState {
    int32_t value;
    int32_t last_clk;
    int32_t step_count;
    int32_t cached;
};

struct DegreeState {
    int32_t value;
};

struct PitchState {
    int32_t value;
};

struct ThruState {
    int32_t value;
};

struct WaveDrumrackState {
    int32_t  value;
    uint32_t phase;
};

/*
 * Common prefix shared by all recordhead state structs (offsets 0..19).
 * Used by the runtime end-of-tick sweep to commit pending writes without
 * knowing which specific variant is in each slot.
 */
struct RecordheadCommon {
    int32_t  value;
    int32_t  head_pos_out;
    uint32_t head_pos;
    uint32_t pending_pos;
    int32_t  pending_val;
    uint32_t pending_head_pos_next;
    uint8_t  pending_valid;
    uint8_t  _pad[3];
};

/* ===== pack12: 12-bit cells packed 2-per-3-bytes ===== */

/*
 * Byte layout for pair at index pair = idx >> 1:
 *   base = pair * 3
 *   byte[base+0] = cell0[7:0]
 *   byte[base+1] = cell1[3:0]<<4 | cell0[11:8]
 *   byte[base+2] = cell1[11:4]
 *
 * M0+: byte loads only (LDRB); no halfword loads at odd addresses.
 * Byte storage for n cells: (n * 3 + 1) >> 1  bytes.
 */

__attribute__((always_inline))
static inline int32_t pack12_read(const uint8_t* buf, uint32_t idx) {
    uint32_t pair = idx >> 1;
    uint32_t base = (pair << 1) + pair;
    if ((idx & 1u) == 0u) {
        return (int32_t)(((uint32_t)buf[base] | (((uint32_t)buf[base + 1u] & 0x0Fu) << 8)));
    } else {
        return (int32_t)((((uint32_t)buf[base + 1u]) >> 4) | (((uint32_t)buf[base + 2u]) << 4));
    }
}

/* Audio cells hold a bipolar sample two's-complement in 12 bits; the read must
   sign-extend so the negative half is not wrapped to a large positive (tape
   cells stay unsigned 0..4095, so only the audio readers op_tap/op_wave use
   this). 0..2047 stay positive; 2048..4095 become -2048..-1. */
static inline int32_t pack12_read_signed(const uint8_t* buf, uint32_t idx) {
    int32_t c = pack12_read(buf, idx);
    return (c >= 2048) ? (c - 4096) : c;
}

__attribute__((always_inline))
static inline void pack12_write(uint8_t* buf, uint32_t idx, int32_t val) {
    uint32_t v    = (uint32_t)val & 0xFFFu;
    uint32_t pair = idx >> 1;
    uint32_t base = (pair << 1) + pair;
    if ((idx & 1u) == 0u) {
        buf[base]      = (uint8_t)(v & 0xFFu);
        buf[base + 1u] = (uint8_t)((buf[base + 1u] & 0xF0u) | (v >> 8));
    } else {
        buf[base + 1u] = (uint8_t)((buf[base + 1u] & 0x0Fu) | ((v & 0xFu) << 4));
        buf[base + 2u] = (uint8_t)(v >> 4);
    }
}

/* ===== audio helpers ===== */

#define SMAX 2047

/* Jack-connection mask (bit = hw_scratch jack index); set each sample from the
   hardware normalisation probe and read by op_connected. */
static uint16_t hw_connected;

static inline int32_t sclamp_(int32_t x) { return x < -SMAX ? -SMAX : (x > SMAX ? SMAX : x); }
static inline int32_t vclamp_(int32_t x) { return x < 0 ? 0 : (x > VMAX ? VMAX : x); }
/* Narrow a 32-bit runtime value to the 12-bit magnitude domain (+-VMAX). In-range
   values (uni- or bipolar) pass through; only out-of-range intermediates (e.g. a
   raw op_mul product) saturate, so a later multiply cannot overflow int32. */
static inline int32_t mclamp_(int32_t x) { return x < -VMAX ? -VMAX : (x > VMAX ? VMAX : x); }

static inline uint32_t umulhi32(uint32_t a, uint32_t b) {
    uint32_t ah = a >> 16, al = a & 0xFFFF, bh = b >> 16, bl = b & 0xFFFF;
    uint32_t lo = al * bl;
    uint32_t m1 = ah * bl + (lo >> 16);
    uint32_t m2 = al * bh + (m1 & 0xFFFF);
    return ah * bh + (m1 >> 16) + (m2 >> 16);
}

static inline int32_t onePoleStep(int32_t diff, uint32_t coefQ32) {
    uint32_t mag = diff < 0 ? (uint32_t)(-diff) : (uint32_t)diff;
    int32_t step = (int32_t)umulhi32(mag, coefQ32);
    return diff < 0 ? -step : step;
}

/* Truncating interpolation used by the drum voices (kick/snare), kept bit-for-bit
 * as ported from Plaits. The oscillators use sine_interp (round-to-nearest). */
static inline int32_t sineInterp_(uint32_t ph) {
    int32_t i = (int32_t)(ph >> 24), frac = (int32_t)((ph >> 16) & 0xFF);
    int32_t a = sine_table[i], b = sine_table[(i + 1) & 0xFF];
    return a + (((b - a) * frac) >> 8);
}

static inline uint32_t xorshift32_(uint32_t s) {
    uint32_t x = s ? s : 1u;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return x;
}

static inline uint32_t rngSeed_(int i) {
    return (0x9E3779B9u ^ ((uint32_t)i * 0x6D2B79F5u)) | 1u;
}

static inline int32_t drumDecayK_(int32_t decay, int shift, int floor_tau) {
    int32_t tau = floor_tau + ((decay * decay) >> shift);
    int32_t k = 65536 / tau;
    return k < 1 ? 1 : (k > 65535 ? 65535 : k);
}

static uint32_t __ditherR = 0x2545F491u;
static inline int32_t ditherShift_(int32_t hi, int shift) {
    if (hi == 0) return 0;
    uint32_t r = __ditherR;
    r ^= r << 13; r ^= r >> 17; r ^= r << 5; int32_t a = (int32_t)(r >> (32 - shift));
    r ^= r << 13; r ^= r >> 17; r ^= r << 5; int32_t b = (int32_t)(r >> (32 - shift));
    __ditherR = r;
    return (hi + a + b - (1 << shift)) >> shift;
}

#if LENS_PERF_PROBE
#define M0P_SYSTICK_CVR (*((volatile uint32_t *)0xE000E018))
static inline uint32_t rt_dwt_read(void) { return M0P_SYSTICK_CVR; }
#endif

#ifndef __not_in_flash_func
#define __not_in_flash_func(f) f
#endif

/* ===== shared constants ===== */

#define VMAX_  4095
#define VMID_  2048
#define SMAX_  2047
#define VBITS_ 12
/* Default pulse/tick width in samples. Pulse ops accept a wider :width; for an
   LED, envelope the pulse in the patch. */
/* Default trigger/gate pulse width (~1.35 ms at 48 kHz): visible on an LED and long
   enough for external gear; harmless to an internal consumer (which edge-detects).
   Override per-op with :width. A deliberate trigger duration, not a control window. */
#define kTickWidth 65

/* ===== arith helpers ===== */

static inline int32_t js_round_div(int32_t a, int32_t b) {
    if (b == 0) return 0;
    int32_t n = 2 * a + b;
    int32_t d = 2 * b;
    int32_t q = n / d;
    int32_t r = n % d;
    if (r != 0 && ((n ^ d) < 0)) q--;
    return q;
}

static inline int32_t js_mod(int32_t a, int32_t b) {
    if (b == 0) return 0;
    int32_t r = a % b;
    if (r != 0 && ((r ^ b) < 0)) r += b;
    return r;
}

static inline int32_t js_spread(int32_t x, int32_t n) {
    int32_t cap = n - 1;
    int32_t num = x * n;
    int32_t bucket = num / (VMAX_ + 1);
    if (num < 0 && num % (VMAX_ + 1) != 0) bucket--;
    return bucket < cap ? bucket : cap;
}

static inline int32_t vclamp(int32_t x) {
    if (x < 0)     return 0;
    if (x > VMAX_) return VMAX_;
    return x;
}

/* note % 12 for note in [0, 255]; falls back to soft-modulo outside. */
static const uint8_t pc12_lut[256] = {
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11,
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11,
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11,
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11,
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11,
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11,
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11,
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11,
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11,
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11,
    0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3
};

static inline int32_t snap_to_mask(int32_t note, int32_t mask) {
    if (!mask) return note;
    int32_t pc = (note >= 0 && note < 256) ? (int32_t)pc12_lut[note]
                                            : ((note % 12) + 12) % 12;
    int32_t best = pc, bestDist = 12;
    for (int32_t d = 0; d < 12; d++) {
        if ((mask >> d) & 1) {
            int32_t dist = d - pc;
            if (dist < 0) dist = -dist;
            if (12 - dist < dist) dist = 12 - dist;
            if (dist < bestDist) { bestDist = dist; best = d; }
        }
    }
    /* Move to the nearest scale tone in the minimal SIGNED direction. A linear
     * (best - pc) shift drops a full octave when the nearest tone is across the
     * octave wrap (e.g. B -> the C above), so fold the delta into [-6, +6]. */
    int32_t delta = best - pc;
    if (delta >  6) delta -= 12;
    if (delta < -6) delta += 12;
    return note + delta;
}

/* ===== stateful helpers ===== */

/* A beat/trigger is a rising crossing of a LOW threshold. One detector serves both
   a ramp (crosses just after the wrap -> fires at the downbeat) and a pulse (crosses
   on arrival). The threshold is low because a phasor ramp spans only 0..VMID. */
#define kEdgeLevel (VMAX_ / 16)
#define FALLING_(x, last) ((x) <= VMID_ && (last) > VMID_)
#define RISING_(x, last)  ((x) > kEdgeLevel && (last) <= kEdgeLevel)

static inline uint32_t midi_clamp(int32_t n) {
    if (n < 0)   return 0;
    if (n > 127) return 127;
    return (uint32_t)n;
}

static inline int32_t phase_to_ramp(uint32_t phase32) {
    /* Full 12-bit scale: 0..VMAX over one turn (the top 12 bits of the phase). */
    return (int32_t)(phase32 >> 20);
}

/* :phase mode — turn a 12-bit exchange-domain phase (0..VMAX = one turn, e.g. a
   phasor's ramp) back into the internal 32-bit phase a shaper expects. */
static inline uint32_t ramp_to_phase(int32_t ramp12) {
    return ((uint32_t)ramp12 & 0xFFFu) << 20;
}

static inline int32_t phase_to_triangle(uint32_t phase32) {
    uint32_t frac19 = phase32 & 0x7FFFFu;
    uint32_t trunc  = phase32 >> 19;
    if (phase32 < 0x80000000u) {
        return (int32_t)(trunc + (frac19 >= 0x40000u ? 1u : 0u)) - 2048;
    } else {
        return 6144 - (int32_t)(trunc + (frac19 > 0x40000u ? 1u : 0u));
    }
}

/* Round-to-nearest interpolation for the oscillators (sine/phasor depth). The
 * drum voices use sineInterp_ (truncating) to match their Plaits heritage. */
static inline int32_t sine_interp(uint32_t phase32) {
    uint32_t idx  = (phase32 >> 24) & 0xFFu;
    uint32_t frac = (phase32 >> 16) & 0xFFu;
    int32_t a = sine_table[idx];
    int32_t b = sine_table[(idx + 1u) & 0xFFu];
    int32_t num = a * 256 + (b - a) * (int32_t)frac;
    if (num >= 0) return (num + 128) >> 8;
    return -(((-num) + 127) >> 8);
}

static inline uint32_t rate_inc(uint32_t mode, int32_t in0) {
    switch (mode) {
      case 0:
        return pitch_table[midi_clamp(in0)];
      case 1: {
        uint32_t hz = (uint32_t)(in0 < 0 ? 0 : in0);
        return hz * 89478u;
      }
      case 2: {
        uint32_t v = (uint32_t)in0;
        return rate_table[(v >> 4) & 0xFFu];
      }
      default: {
        int32_t v = vclamp_(in0);
        return rate_table[32u + (((uint32_t)v * 94u) >> 12)];
      }
    }
}

static inline uint32_t pm_offset(int32_t pm) {
    /* Modulator value (+-2047) -> phase swing. The <<21 shift is done in uint32
     * (modular, sign preserved by two's complement) so a full-depth modulator pushes
     * the carrier phase a full cycle (index ~2pi) monotonically, with no mid-range
     * wrap/aliasing. A signed shift would clamp at the sign bit near half a cycle. */
    return ((uint32_t)pm) << 21;
}

/* round(val * depth / VMAX): the shared 12-bit-normalised product used by vca,
 * ring, lpg and sine depth. The %/correction gives round-half-up for both signs. */
static inline int32_t scale_depth(int32_t val, int32_t depth) {
    int32_t n = val * depth;
    int32_t b = VMAX_;
    int32_t n2 = n * 2 + b;
    int32_t d2 = b * 2;
    int32_t q = n2 / d2;
    int32_t r = n2 % d2;
    if (r != 0 && ((n2 ^ d2) < 0)) q--;
    return q;
}

/* ===== filters helpers ===== */

static inline uint32_t lcg(uint32_t s) {
    return (uint32_t)(1664525u * s + 1013904223u);
}

static inline int32_t round16(int32_t q16) {
    if (q16 >= 0) return (q16 + 32768) >> 16;
    return -(((-q16) + 32767) >> 16);
}

static inline int32_t onepole_step(int32_t y_q16, int32_t x, int32_t cut) {
    int32_t k = cut * 16;
    y_q16 += (mclamp_(x) - (y_q16 >> 16)) * k;
    return y_q16;
}

/* ===== arith kernels ===== */

void OP_FN(op_add)(struct Slot* s) {
    *(int32_t*)s->out = *(int32_t*)s->in0 + *(int32_t*)s->in1;
}
void OP_FN(op_sub)(struct Slot* s) {
    *(int32_t*)s->out = *(int32_t*)s->in0 - *(int32_t*)s->in1;
}
/* :sat variants saturate at the value rails [0, VMAX] instead of wrapping, like a
   CV hitting the supply rails. (Audio uses `clip`/`saturate` for the bipolar rails.) */
void OP_FN(op_add_sat)(struct Slot* s) {
    *(int32_t*)s->out = vclamp_(*(int32_t*)s->in0 + *(int32_t*)s->in1);
}
void OP_FN(op_sub_sat)(struct Slot* s) {
    *(int32_t*)s->out = vclamp_(*(int32_t*)s->in0 - *(int32_t*)s->in1);
}
void OP_FN(op_mul)(struct Slot* s) {
    int32_t a = *(int32_t*)s->in0, b = *(int32_t*)s->in1;
    *(int32_t*)s->out = a * b;   /* true multiply; gain-scaling is op_vca */
}
void OP_FN(op_div)(struct Slot* s) {
    *(int32_t*)s->out = js_round_div(*(int32_t*)s->in0, *(int32_t*)s->in1);
}
void OP_FN(op_mod)(struct Slot* s) {
    *(int32_t*)s->out = js_mod(*(int32_t*)s->in0, *(int32_t*)s->in1);
}
void OP_FN(op_spread)(struct Slot* s) {
    *(int32_t*)s->out = js_spread(*(int32_t*)s->in0, *(int32_t*)s->in1);
}
void OP_FN(op_gt)(struct Slot* s) {
    *(int32_t*)s->out = *(int32_t*)s->in0 > *(int32_t*)s->in1 ? VMAX_ : 0;
}
void OP_FN(op_gte)(struct Slot* s) {
    *(int32_t*)s->out = *(int32_t*)s->in0 >= *(int32_t*)s->in1 ? VMAX_ : 0;
}
void OP_FN(op_lt)(struct Slot* s) {
    *(int32_t*)s->out = *(int32_t*)s->in0 < *(int32_t*)s->in1 ? VMAX_ : 0;
}
void OP_FN(op_lte)(struct Slot* s) {
    *(int32_t*)s->out = *(int32_t*)s->in0 <= *(int32_t*)s->in1 ? VMAX_ : 0;
}
void OP_FN(op_eq)(struct Slot* s) {
    *(int32_t*)s->out = *(int32_t*)s->in0 == *(int32_t*)s->in1 ? VMAX_ : 0;
}
void OP_FN(op_ne)(struct Slot* s) {
    *(int32_t*)s->out = *(int32_t*)s->in0 != *(int32_t*)s->in1 ? VMAX_ : 0;
}
void OP_FN(op_if)(struct Slot* s) {
    int32_t cond = *(int32_t*)s->in0;
    *(int32_t*)s->out = cond != 0 ? *(int32_t*)s->in1 : *(int32_t*)s->in2;
}
void OP_FN(op_not)(struct Slot* s) {
    *(int32_t*)s->out = *(int32_t*)s->in0 == 0 ? VMAX_ : 0;
}
void OP_FN(op_max)(struct Slot* s) {
    int32_t a = *(int32_t*)s->in0, b = *(int32_t*)s->in1;
    *(int32_t*)s->out = a > b ? a : b;
}
void OP_FN(op_min)(struct Slot* s) {
    int32_t a = *(int32_t*)s->in0, b = *(int32_t*)s->in1;
    *(int32_t*)s->out = a < b ? a : b;
}
void OP_FN(op_abs)(struct Slot* s) {
    int32_t a = *(int32_t*)s->in0;
    *(int32_t*)s->out = a < 0 ? -a : a;
}
void OP_FN(op_rect)(struct Slot* s) {
    int32_t a = *(int32_t*)s->in0;
    *(int32_t*)s->out = a > 0 ? a : 0;
}
void OP_FN(op_and)(struct Slot* s) {
    int32_t a = *(int32_t*)s->in0, b = *(int32_t*)s->in1;
    *(int32_t*)s->out = (a != 0 && b != 0) ? VMAX_ : 0;
}
void OP_FN(op_or)(struct Slot* s) {
    int32_t a = *(int32_t*)s->in0, b = *(int32_t*)s->in1;
    *(int32_t*)s->out = (a != 0 || b != 0) ? VMAX_ : 0;
}
void OP_FN(op_xor)(struct Slot* s) {
    *(int32_t*)s->out = *(int32_t*)s->in0 ^ *(int32_t*)s->in1;
}
void OP_FN(op_v_oct)(struct Slot* s) {
    /* Emit the MIDI note (0..127) itself; the cv-out jack feeds it to the card's
       CALIBRATED 1V/oct DAC path (CVOutMIDINote). A pitch out is recognised by its
       source kernel being op_v_oct (see runtime_drive_terminals), so no generic
       12-bit LUT is used (that clipped against the signed DAC range). The host
       runner has no DAC, so it simply reports the note number. */
    int32_t note = *(int32_t*)s->in0;
    if (note < 0)   note = 0;
    if (note > 127) note = 127;
    *(int32_t*)s->out = note;
}
void OP_FN(op_window)(struct Slot* s) {
    struct NodeStateBase* st = (struct NodeStateBase*)s->out;
    int32_t a  = *(int32_t*)s->in0;
    int32_t lo = *(int32_t*)s->in1;
    int32_t hi = *(int32_t*)s->in2;
    st->value = (a > lo && a < hi) ? VMAX_ : 0;
}
void OP_FN(op_range)(struct Slot* s) {
    struct NodeStateBase* st = (struct NodeStateBase*)s->out;
    int32_t x = *(int32_t*)s->in0;
    uint32_t p = s->param0;
    if (p & 0x40000000u) {              /* to-value: expand 0..V-1 -> 0..VMAX */
        int32_t V = (int32_t)(p & 0x3FFFFFFFu);
        if (V <= 1) { st->value = 0; return; }
        st->value = js_round_div(x * VMAX_, V - 1);
    } else if (p) {                     /* to-index: quantise to N buckets */
        int32_t N = (int32_t)(p & 0x3FFFFFFFu);
        if (N < 1) N = 1;
        int32_t bucket = (x * N) / (VMAX_ + 1);
        if (bucket < 0) bucket = 0;
        if (bucket > N - 1) bucket = N - 1;
        st->value = bucket;
    } else {
        st->value = x;
    }
}
void OP_FN(op_cv)(struct Slot* s) {
    struct NodeStateBase* st = (struct NodeStateBase*)s->out;
    int32_t x = *(int32_t*)s->in0;
    if (s->param0 & 1u) {
        st->value = x - VMID_;
    } else {
        st->value = js_round_div(x * 2047, VMAX_);
    }
}
void OP_FN(op_snap)(struct Slot* s) {
    struct NodeStateBase* st = (struct NodeStateBase*)s->out;
    int32_t note = *(int32_t*)s->in0;
    int32_t mask = s->param0 ? (int32_t)s->param0 : *(int32_t*)s->in1;
    st->value = snap_to_mask(note, mask & 0xFFF);
}
void OP_FN(op_quantise)(struct Slot* s) {
    struct NodeStateBase* st = (struct NodeStateBase*)s->out;
    int32_t val  = *(int32_t*)s->in0;
    int32_t midi = js_round_div(val * 127, VMAX_);
    int32_t mask = s->param0 ? (int32_t)s->param0 : *(int32_t*)s->in1;
    int32_t note = snap_to_mask(midi, mask & 0xFFF);
    st->value = js_round_div(note * VMAX_, 127);   /* MIDI 127 -> VMAX */
}
void OP_FN(op_transpose)(struct Slot* s) {
    ((struct NodeStateBase*)s->out)->value = vclamp(*(int32_t*)s->in0 + *(int32_t*)s->in1);
}
void OP_FN(op_invert)(struct Slot* s) {
    ((struct NodeStateBase*)s->out)->value = VMAX_ - vclamp(*(int32_t*)s->in0);
}
void OP_FN(op_shift)(struct Slot* s) {
    ((struct NodeStateBase*)s->out)->value = vclamp(*(int32_t*)s->in0 + mclamp_(*(int32_t*)s->in1) * 256);
}
void OP_FN(op_mask)(struct Slot* s) {
    ((struct NodeStateBase*)s->out)->value = (*(int32_t*)s->in0 & *(int32_t*)s->in1) & 0xFFF;
}
void OP_FN(op_bit)(struct Slot* s) {
    int32_t v = *(int32_t*)s->in0, n = *(int32_t*)s->in1 & 0xF;
    ((struct NodeStateBase*)s->out)->value = ((v >> n) & 1) ? VMAX_ : 0;
}
void OP_FN(op_feedback)(struct Slot* s) {
    ((struct NodeStateBase*)s->out)->value = *(int32_t*)s->in0;
}
void OP_FN(op_len)(struct Slot* s) {
    ((struct NodeStateBase*)s->out)->value = (int32_t)s->param0;
}
void OP_FN(op_record)(struct Slot* s) {
    ((struct NodeStateBase*)s->out)->value = 0;
}
/* `connected`: VMAX if a cable is patched into the jack (param0 = jack index),
   else 0. `normal` is sugar: (if (connected jack) jack default). Keyed on real
   jack detection, so a clock pulse (0 between edges) still counts as connected. */
void OP_FN(op_connected)(struct Slot* s) {
    ((struct NodeStateBase*)s->out)->value = ((hw_connected >> s->param0) & 1u) ? VMAX_ : 0;
}
void OP_FN(op_morph)(struct Slot* s) {
    struct NodeStateBase* st = (struct NodeStateBase*)s->out;
    int32_t n = (int32_t)s->param0;
    if (n <= 1) { st->value = 0; return; }
    int32_t nsig = n - 1;
    const int32_t* ins[4] = {
        (const int32_t*)s->in0, (const int32_t*)s->in1,
        (const int32_t*)s->in2, (const int32_t*)s->in3
    };
    int32_t pos = *(ins[nsig < 4 ? nsig : 3]);
    if (nsig <= 1) { st->value = *(ins[0]); return; }
    int32_t nsig1 = nsig - 1;
    int32_t raw = pos * nsig1;
    int32_t i0  = raw / VMAX_;
    int32_t f16 = ((raw % VMAX_) << 16) / VMAX_;
    if (i0 < 0) i0 = 0;
    if (i0 >= nsig - 1) { st->value = *(ins[(nsig - 1) < 3 ? nsig - 1 : 3]); return; }
    int32_t a = mclamp_(*(ins[i0 < 4 ? i0 : 3]));
    int32_t b = mclamp_(*(ins[(i0 + 1) < 4 ? (i0 + 1) : 3]));
    int32_t v_q16 = a * 65536 + (b - a) * f16;
    int32_t out;
    if (v_q16 >= 0) out = (v_q16 + 32768) >> 16;
    else            out = -(((-v_q16) + 32767) >> 16);
    st->value = out;
}

/* ===== stateful / leaf kernels ===== */

void OP_FN(op_knob)(struct Slot* s) {
    ((struct LeafState*)s->out)->value = *(const int32_t*)s->in0;
}
void OP_FN(op_cv_in)(struct Slot* s) {
    ((struct LeafState*)s->out)->value = *(const int32_t*)s->in0;
}
void OP_FN(op_audio_in)(struct Slot* s) {
    ((struct LeafState*)s->out)->value = *(const int32_t*)s->in0;
}
void OP_FN(op_pulse_in)(struct Slot* s) {
    ((struct LeafState*)s->out)->value = *(const int32_t*)s->in0;
}
void OP_FN(op_switch)(struct Slot* s) {
    ((struct LeafState*)s->out)->value = *(const int32_t*)s->in0;
}
void OP_FN(op_detent)(struct Slot* s) {
    struct LeafState* st = (struct LeafState*)s->out;
    int32_t x = *(const int32_t*)s->in0;
    const int32_t W = 96;
    const void* pts[3] = { s->in1, s->in2, s->in3 };
    uint32_t npts = s->param0;
    for (uint32_t i = 0; i < npts && i < 3; i++) {
        int32_t p = *(const int32_t*)pts[i];
        if (x >= p - W && x <= p + W) { x = p; break; }
    }
    st->value = x;
}

void OP_FN(op_phasor)(struct Slot* s) {
    struct PhasorState* st = (struct PhasorState*)s->out;
    if (s->param0 & 4u) {                        /* :sync to an external clock */
        int32_t sync = *(const int32_t*)s->in1;
        st->sync_count++;
        /* Accept an edge only if it is >= one control window since the last accepted
         * one: that debounces ringing / sub-1ms noise (sync_count keeps counting
         * through rejected edges). An accepted edge IS the downbeat: it locks the
         * rate, hard-syncs the phase, and registers the beat. The external edge is
         * the beat (not the natural wrap), so a synced clock ticks on each pulse. */
        if (RISING_(sync, st->last_sync) && st->sync_count >= 64u) {
            if (s->param0 & 8u)              /* lock: external clock also sets the rate */
                st->locked_inc = 0xFFFFFFFFu / st->sync_count;
            st->sync_count = 0;
            st->phase = 0;                   /* hard-sync phase to the external beat */
        }
        st->last_sync = sync;
    }
    /* :lock uses the measured rate once an edge has set it; until then (and if no
       clock is ever patched) free-run at the internal rate rather than freezing. */
    uint32_t inc = ((s->param0 & 8u) && st->locked_inc) ? st->locked_inc
                                    : rate_inc(s->param0 & 3u, *(const int32_t*)s->in0);
    st->phase += inc;
    st->value = phase_to_ramp(st->phase);
    /* The phasor outputs only its ramp. A consumer that wants the beat edge-detects
       it (rising through the low threshold), firing just after the wrap/reset. */
}
void OP_FN(op_sine)(struct Slot* s) {
    struct SineState* st = (struct SineState*)s->out;
    uint32_t phase32;
    if (s->param0 & 16u) {                        /* :phase — driven by an external phase */
        phase32 = ramp_to_phase(*(const int32_t*)s->in0);
        st->phase = phase32;
    } else {
        st->phase += rate_inc(s->param0 & 3u, *(const int32_t*)s->in0);
        phase32 = st->phase;
    }
    if (s->param0 & 4u) phase32 += pm_offset(*(const int32_t*)s->in1);
    int32_t val = sine_interp(phase32);
    if (s->param0 & 8u) val = scale_depth(val, *(const int32_t*)s->in2);
    st->value = val;
}
void OP_FN(op_triangle)(struct Slot* s) {
    struct TriangleState* st = (struct TriangleState*)s->out;
    uint32_t phase32;
    if (s->param0 & 16u) {                        /* :phase — driven by an external phase */
        phase32 = ramp_to_phase(*(const int32_t*)s->in0);
    } else {
        st->phase += rate_inc(s->param0 & 3u, *(const int32_t*)s->in0);
        phase32 = st->phase;
    }
    st->value = phase_to_triangle(phase32);
}

/* DPW band-limited saw (Valimaki 2005, after Chris Johnson's Utility-Pair card). */
static inline int32_t dpw_saw(int32_t signed_phase, int32_t* last_parab, int32_t invc) {
    int32_t r    = signed_phase >> 16;
    int32_t para = r * r;
    int32_t diff = para - *last_parab;
    *last_parab  = para;
    if (invc == 0) return 0;
    return (diff / invc) >> 4;
}

void OP_FN(op_saw)(struct Slot* s) {
    struct SawState* st = (struct SawState*)s->out;
    if (s->param0 & 16u) {                        /* :phase — naive bipolar ramp from an
        external phase. NOT band-limited (the DPW needs a continuous rate); use pitch
        mode for a clean saw. */
        st->value = ((*(const int32_t*)s->in0) & 0xFFF) * 2 - VMAX_;
        return;
    }
    uint32_t inc = rate_inc(s->param0 & 3u, *(const int32_t*)s->in0);
    st->phase += inc;
    int32_t invc = (int32_t)(inc >> 15);
    int32_t v = dpw_saw((int32_t)st->phase, &st->last_parab, invc);
    /* clamp: the DPW differentiator overshoots on its first sample (the previous
       parabola is zero) and occasionally at extreme rates; keep it in range. */
    if (v > VMAX_) v = VMAX_; else if (v < -VMAX_) v = -VMAX_;
    st->value = v;
}
void OP_FN(op_square)(struct Slot* s) {
    struct SquareState* st = (struct SquareState*)s->out;
    if (s->param0 & 16u) {                        /* :phase — naive square from an external
        phase (not band-limited; use pitch mode for a clean square). */
        st->value = (((*(const int32_t*)s->in0) & 0xFFF) < VMID_) ? VMAX_ : -VMAX_;
        return;
    }
    uint32_t inc = rate_inc(s->param0 & 3u, *(const int32_t*)s->in0);
    st->phase += inc;
    int32_t invc = (int32_t)(inc >> 15);
    int32_t a = dpw_saw((int32_t)st->phase, &st->last_parab_a, invc);
    int32_t b = dpw_saw((int32_t)(st->phase + 0x80000000u), &st->last_parab_b, invc);
    int32_t v = a - b;
    if (v > VMAX_) v = VMAX_; else if (v < -VMAX_) v = -VMAX_;
    st->value = v;
}

void OP_FN(op_edge)(struct Slot* s) {
    struct EdgeState* st = (struct EdgeState*)s->out;
    int32_t x = *(const int32_t*)s->in0;
    if (RISING_(x, st->last)) st->pulse += (s->param0 != 0) ? (int32_t)s->param0 : kTickWidth;
    st->last = x;
    if (st->pulse > 0) { st->pulse--; st->value = VMAX_; }
    else st->value = 0;
}
void OP_FN(op_fall)(struct Slot* s) {
    struct FallState* st = (struct FallState*)s->out;
    int32_t x = *(const int32_t*)s->in0;
    if (FALLING_(x, st->last)) st->pulse += (s->param0 != 0) ? (int32_t)s->param0 : kTickWidth;
    st->last = x;
    if (st->pulse > 0) { st->pulse--; st->value = VMAX_; }
    else st->value = 0;
}
void OP_FN(op_diff)(struct Slot* s) {
    struct DiffState* st = (struct DiffState*)s->out;
    int32_t x = *(const int32_t*)s->in0;
    st->value = x - st->last;
    st->last = x;
}
void OP_FN(op_toggle)(struct Slot* s) {
    struct ToggleState* st = (struct ToggleState*)s->out;
    int32_t x = *(const int32_t*)s->in0;
    if (RISING_(x, st->last)) st->state = (st->state == 0) ? VMAX_ : 0;
    st->last = x;
    st->value = st->state;
}
void OP_FN(op_hold)(struct Slot* s) {
    struct HoldState* st = (struct HoldState*)s->out;
    int32_t val = *(const int32_t*)s->in0;
    int32_t on  = *(const int32_t*)s->in1;
    if (on > VMID_) st->last = val;
    st->value = st->last;
}
void OP_FN(op_gate)(struct Slot* s) {
    struct GateState* st = (struct GateState*)s->out;
    int32_t x   = *(const int32_t*)s->in0;
    int32_t len = (s->param0 != 0) ? (int32_t)s->param0 : kTickWidth;
    if (RISING_(x, st->last)) st->hold_count = len;
    st->last = x;
    if (st->hold_count > 0) { st->hold_count--; st->value = VMAX_; }
    else st->value = (x > VMID_) ? VMAX_ : 0;
}
void OP_FN(op_schmitt)(struct Slot* s) {
    struct SchmittState* st = (struct SchmittState*)s->out;
    int32_t x  = *(const int32_t*)s->in0;
    int32_t lo = *(const int32_t*)s->in1;
    int32_t hi = *(const int32_t*)s->in2;
    if (x > hi) st->last = VMAX_;
    else if (x < lo) st->last = 0;
    st->value = st->last;
}
void OP_FN(op_z1)(struct Slot* s) {
    struct Z1State* st = (struct Z1State*)s->out;
    int32_t x = *(const int32_t*)s->in0;
    st->value = st->last;
    st->last = x;
}
void OP_FN(op_every)(struct Slot* s) {
    struct EveryState* st = (struct EveryState*)s->out;
    int32_t N   = *(const int32_t*)s->in0;
    int32_t clk = *(const int32_t*)s->in1;
    if (N < 1) N = 1;
    if (FALLING_(clk, st->last_clk)) {
        st->counter = (st->counter + 1) % N;
        if (st->counter == 0) st->pulse = (s->param0 != 0) ? (int32_t)s->param0 : kTickWidth;
    }
    st->last_clk = clk;
    if (st->pulse > 0) { st->pulse--; st->value = VMAX_; }
    else st->value = 0;
}
void OP_FN(op_euclid)(struct Slot* s) {
    struct EuclidState* st = (struct EuclidState*)s->out;
    int32_t P   = *(const int32_t*)s->in0;
    int32_t S   = *(const int32_t*)s->in1;
    int32_t clk = *(const int32_t*)s->in2;
    if (P < 0) P = 0;
    if (S < 1) S = 1;
    if (FALLING_(clk, st->last_clk)) {
        int32_t i = st->counter % S;
        int32_t prev = (i > 0) ? (i - 1) : (S - 1);
        int32_t cur_step  = (i    * P) / S;
        int32_t prev_step = (prev * P) / S;
        if (cur_step != prev_step) st->pulse = (s->param0 != 0) ? (int32_t)s->param0 : kTickWidth;
        st->counter = (st->counter + 1) % S;
    }
    st->last_clk = clk;
    if (st->pulse > 0) { st->pulse--; st->value = VMAX_; }
    else st->value = 0;
}
void OP_FN(op_turns)(struct Slot* s) {
    struct TurnsState* st = (struct TurnsState*)s->out;
    int32_t clk = *(const int32_t*)s->in0;
    if (FALLING_(clk, st->last_clk)) st->count = (st->count + 1) & VMAX_;
    st->last_clk = clk;
    st->value = st->count;
}
void OP_FN(op_counter)(struct Slot* s) {
    struct CounterState* st = (struct CounterState*)s->out;
    int32_t bars = *(const int32_t*)s->in0;
    int32_t clk  = *(const int32_t*)s->in1;
    if (bars < 1) bars = 1;
    if (FALLING_(clk, st->last_clk)) st->count = (st->count + 1) % bars;
    st->last_clk = clk;
    st->value = st->count;
}

/* ===== filters / audio-shaping kernels ===== */

void OP_FN(op_vca)(struct Slot* s) {
    struct NodeStateBase* st = (struct NodeStateBase*)s->out;
    st->value = scale_depth(*(const int32_t*)s->in0, *(const int32_t*)s->in1);
}
void OP_FN(op_ring)(struct Slot* s) {
    struct NodeStateBase* st = (struct NodeStateBase*)s->out;
    st->value = scale_depth(*(const int32_t*)s->in0, *(const int32_t*)s->in1);
}
void OP_FN(op_mix2)(struct Slot* s) {
    struct NodeStateBase* st = (struct NodeStateBase*)s->out;
    int32_t a = *(const int32_t*)s->in0;
    int32_t b = *(const int32_t*)s->in1;
    int32_t sum = a + b;
    if (sum >= 0) st->value = (sum + 1) >> 1;
    else          st->value = -((-sum) >> 1);
}
void OP_FN(op_mix)(struct Slot* s) {
    struct NodeStateBase* st = (struct NodeStateBase*)s->out;
    uint32_t n = s->param0 ? s->param0 : 2u;
    int32_t sum = *(const int32_t*)s->in0;
    if (n > 1) sum += *(const int32_t*)s->in1;
    if (n > 2) sum += *(const int32_t*)s->in2;
    if (n > 3) sum += *(const int32_t*)s->in3;
    int32_t in = (int32_t)n;
    if (sum >= 0) st->value = (sum + in / 2) / in;
    else          st->value = -((-sum + (in - 1) / 2) / in);
}
void OP_FN(op_lpf)(struct Slot* s) {
    struct OnePoleState* st = (struct OnePoleState*)s->out;
    st->y_q16 = onepole_step(st->y_q16, *(const int32_t*)s->in0, *(const int32_t*)s->in1);
    st->value = round16(st->y_q16);
}
void OP_FN(op_hpf)(struct Slot* s) {
    struct OnePoleState* st = (struct OnePoleState*)s->out;
    int32_t x = *(const int32_t*)s->in0;
    st->y_q16 = onepole_step(st->y_q16, x, *(const int32_t*)s->in1);
    st->value = x - round16(st->y_q16);
}
/* average, slew: one-pole low-pass smoothers (same body, different names). */
void OP_FN(op_average)(struct Slot* s) {
    struct OnePoleState* st = (struct OnePoleState*)s->out;
    st->y_q16 = onepole_step(st->y_q16, *(const int32_t*)s->in0, *(const int32_t*)s->in1);
    st->value = round16(st->y_q16);
}
void OP_FN(op_slew)(struct Slot* s) {
    struct OnePoleState* st = (struct OnePoleState*)s->out;
    st->y_q16 = onepole_step(st->y_q16, *(const int32_t*)s->in0, *(const int32_t*)s->in1);
    st->value = round16(st->y_q16);
}
void OP_FN(op_vcf)(struct Slot* s) {
    struct VcfState* st = (struct VcfState*)s->out;
    int32_t x   = *(const int32_t*)s->in0;
    int32_t cut = *(const int32_t*)s->in1;
    int32_t res  = *(const int32_t*)s->in2;
    if (res < 0) res = 0; else if (res > VMAX_) res = VMAX_;
    int32_t port = (int32_t)s->param0 & 3;
    int32_t k  = cut * 16;
    int32_t qf = (VMAX_ - res) * 16;
    int32_t bp_int = st->bp_q16 >> 16;
    st->lp_q16 += k * bp_int;
    if (st->lp_q16 >  (int32_t)(VMAX_ * 65536)) st->lp_q16 =  (int32_t)(VMAX_ * 65536);
    if (st->lp_q16 < -(int32_t)(VMAX_ * 65536)) st->lp_q16 = -(int32_t)(VMAX_ * 65536);
    int32_t lp_int = st->lp_q16 >> 16;
    int32_t hp = x - lp_int - ((qf * bp_int) >> 16);
    st->bp_q16 += k * hp;
    if (st->bp_q16 >  (int32_t)(VMAX_ * 65536)) st->bp_q16 =  (int32_t)(VMAX_ * 65536);
    if (st->bp_q16 < -(int32_t)(VMAX_ * 65536)) st->bp_q16 = -(int32_t)(VMAX_ * 65536);
    int32_t bp_new = st->bp_q16 >> 16;
    int32_t out;
    switch (port) {
        case 1: out = hp;              break;
        case 2: out = bp_new;          break;
        case 3: out = lp_int - bp_new; break;
        default: out = lp_int;         break;
    }
    if (out >  VMAX_) out =  VMAX_;
    if (out < -VMAX_) out = -VMAX_;
    st->value = out;
}
void OP_FN(op_noise)(struct Slot* s) {
    struct NoiseState* st = (struct NoiseState*)s->out;
    if (st->rng == 0) st->rng = 12345u;
    st->rng = lcg(st->rng);
    st->value = (int32_t)(st->rng >> 20) - VMID_;
}
void OP_FN(op_random)(struct Slot* s) {
    struct RandomState* st = (struct RandomState*)s->out;
    if (st->rng == 0) { st->rng = 99991u; st->cached_value = VMID_; }
    int32_t clk = *(const int32_t*)s->in0;
    if (FALLING_(clk, st->last_clk)) {
        st->rng = lcg(st->rng);
        st->cached_value = (int32_t)(st->rng >> 20);
    }
    st->last_clk = clk;
    st->value = st->cached_value;
}
void OP_FN(op_chance)(struct Slot* s) {
    struct ChanceState* st = (struct ChanceState*)s->out;
    if (st->rng == 0) { st->rng = 77771u; st->cached_value = 0; }
    int32_t p   = *(const int32_t*)s->in0;
    int32_t clk = *(const int32_t*)s->in1;
    if (FALLING_(clk, st->last_clk)) {
        st->rng = lcg(st->rng);
        int32_t r = (int32_t)(st->rng >> 20);
        if (r == VMAX_) r = VMAX_ - 1;
        st->cached_value = (r < p) ? VMAX_ : 0;
    }
    st->last_clk = clk;
    st->value = st->cached_value;
}
void OP_FN(op_walk)(struct Slot* s) {
    struct WalkState* st = (struct WalkState*)s->out;
    if (st->rng == 0) { st->rng = 55551u; st->cached_value = VMID_; }
    int32_t clk  = *(const int32_t*)s->in0;
    int32_t step = (s->param0 != 0) ? (int32_t)s->param0 : 128;
    if (FALLING_(clk, st->last_clk)) {
        st->rng = lcg(st->rng);
        /* high bit: an LCG's low bit alternates (period 2), which collapses the walk
         * to a 2-value toggle; the top bit is well distributed. */
        int32_t dir = (st->rng >> 31) ? 1 : -1;
        int32_t v = st->cached_value + dir * step;
        if (v < 0)     v = 0;
        if (v > VMAX_) v = VMAX_;
        st->cached_value = v;
    }
    st->last_clk = clk;
    st->value = st->cached_value;
}
void OP_FN(op_lpg)(struct Slot* s) {
    struct LpgState* st = (struct LpgState*)s->out;
    int32_t x    = *(const int32_t*)s->in0;
    int32_t ctrl = *(const int32_t*)s->in1;
    if (ctrl < 0)     ctrl = 0;
    if (ctrl > VMAX_) ctrl = VMAX_;
    st->y_q16 = onepole_step(st->y_q16, x, ctrl);
    st->value = scale_depth(round16(st->y_q16), ctrl);
}
void OP_FN(op_envfollow)(struct Slot* s) {
    struct EnvFollowState* st = (struct EnvFollowState*)s->out;
    int32_t x = *(const int32_t*)s->in0;
    if (x < 0) x = -x;
    int32_t cut = *(const int32_t*)s->in1;
    if (cut < 0)     cut = 0;
    if (cut > VMAX_) cut = VMAX_;
    st->y_q16 = onepole_step(st->y_q16, x, cut);
    st->value = round16(st->y_q16);
}
void OP_FN(op_wavefold)(struct Slot* s) {
    struct WavefoldState* st = (struct WavefoldState*)s->out;
    int32_t sig = *(const int32_t*)s->in0;
    int32_t drive = *(const int32_t*)s->in1;
    if (drive < 0)     drive = 0;
    if (drive > VMAX_) drive = VMAX_;
    int32_t x   = (sig * (256 + drive)) >> 8;
    int32_t xw  = (x + 2048) & 8191;
    int32_t val;
    if (xw < 4096) {
        val = (((xw * 2 + 1) * (xw * 2 - 8191)) >> 3);
    } else {
        val = (-((xw * 2 - 8191) * (xw * 2 - 16383))) >> 3;
    }
    int32_t dx = x - st->lastx;
    int32_t ret;
    if (dx > 1 || dx < -1) {
        ret = (val - st->lastval) / dx;
    } else {
        int32_t mid = (x + st->lastx) >> 1;
        int32_t mw  = (mid + 2048) & 8191;
        ret = (mw < 4096) ? (mw - 2048) : ((8191 - mw) - 2048);
    }
    st->lastx   = x;
    st->lastval = val;
    if (ret >  SMAX_) ret =  SMAX_;
    if (ret < -SMAX_) ret = -SMAX_;
    st->value = ret;
}
void OP_FN(op_crush)(struct Slot* s) {
    struct CrushState* st = (struct CrushState*)s->out;
    int32_t x    = *(const int32_t*)s->in0;
    int32_t rate = *(const int32_t*)s->in1;
    if (rate < 0)     rate = 0;
    if (rate > VMAX_) rate = VMAX_;
    int32_t diff = VMAX_ - rate;
    int32_t rounded = (diff * 2 + 100) / 200;
    int32_t N = rounded + 1;
    if (N < 1) N = 1;
    if (st->count <= 0) { st->held = x; st->count = N; }
    st->count--;
    st->value = st->held;
}

/* Cubic soft-clip f(v) = 1.5v - 0.5v^3, normalised so |v| >= SAT_Q maps to the
   rails. Slope 1.5 at the origin gives the curve makeup so it reaches full scale
   at v = +-SAT_Q. Integer-only: SAT_Q is a power of two so the divides are shifts
   and v*v / v*u2 stay inside int32. */
#define SAT_SHIFT 11
#define SAT_Q     (1 << SAT_SHIFT)   /* 2048 */
static inline int32_t sat_cubic(int32_t v) {
    if (v >=  SAT_Q) return  SMAX_;
    if (v <= -SAT_Q) return -SMAX_;
    int32_t u2 = (v * v)  >> SAT_SHIFT;   /* v^2 / Q   in [0, Q]   */
    int32_t u3 = (v * u2) >> SAT_SHIFT;   /* v^3 / Q^2 in [-Q, Q]  */
    int32_t r  = (3 * v - u3) >> 1;       /* 1.5v - 0.5 v^3/Q^2    */
    return sclamp_(r);
}
/* in0=sig in1=drive in2=bias in3=mix in4=level. drive pre-gains the input; bias
   shifts the operating point for asymmetric (even-harmonic) clipping, removed
   from the output so silence stays at zero; mix blends dry/wet (Q12); level is
   output makeup gain (Q12). */
void OP_FN(op_saturate)(struct Slot* s) {
    int32_t sig   = *(const int32_t*)s->in0;
    int32_t drive = *(const int32_t*)s->in1;
    int32_t bias  = *(const int32_t*)s->in2;
    int32_t mix   = *(const int32_t*)s->in3;
    int32_t level = *(const int32_t*)s->in4;
    if (drive < 0) drive = 0; else if (drive > VMAX_) drive = VMAX_;
    if (mix   < 0) mix   = 0; else if (mix   > VMAX_) mix   = VMAX_;
    if (level < 0) level = 0; else if (level > VMAX_) level = VMAX_;
    int32_t g   = 256 + drive;                       /* Q8 pre-gain, drive 0 = unity */
    int32_t xg  = (sig * g) >> 8;
    int32_t wet = sat_cubic(xg + bias) - sat_cubic(bias);
    int32_t out = sig + (((wet - sig) * mix) >> 12); /* dry/wet blend */
    out = (out * level) >> 12;                       /* makeup gain */
    *(int32_t*)s->out = sclamp_(out);
}

/* ===== drums kernels ===== */
/* Drum voices after Mutable Instruments Plaits (Émilie Gillet, MIT).
 * Reimplemented for the 12-bit Loupe runtime. Numerics per
 * attic/specs/heritage-kernels.md. */

void OP_FN(op_kick)(struct Slot* s) {
    struct KickState* st = (struct KickState*)s->out;
    int32_t trig  = s->in0 ? slot_in0(s) : 0;
    if (RISING_(trig, st->last_trig)) {
        st->level = SMAX_ << 12;
        st->pitchEnv = 1 << 15;
        st->phase = 0;
    }
    st->last_trig = trig;
    int32_t note  = s->in1 ? slot_in1(s) : 24;
    int32_t decay = vclamp_(s->in2 ? slot_in2(s) : VMID_);
    int32_t drive = vclamp_(s->in3 ? slot_in3(s) : 0);
    int32_t sweep = vclamp_(s->in4 ? slot_in4(s) : 0);
    uint32_t base = pitch_table[note & 0x7F];
    if (!base) base = 2926328u;
    int32_t pe = st->pitchEnv;
    uint32_t baseEnv = umulhi32(base, (uint32_t)pe << 16);
    uint32_t inc = base + (uint32_t)((int32_t)(baseEnv >> 7) * sweep);
    if (inc > 1700000000u || inc < base) inc = 1700000000u;
    st->pitchEnv = (pe * 65366) >> 16;
    st->phase += inc;
    int32_t osc = sineInterp_(st->phase);
    int32_t g = 256 + ((drive * drive) >> 13);
    int32_t hot = sclamp_((osc * g) >> 8);
    int32_t shaped = osc + (((hot - osc) * drive) >> VBITS_);
    if (decay != st->cached_decay || !st->cached_k) { st->cached_k = drumDecayK_(decay, 10, 48); st->cached_decay = decay; }
    int32_t k = st->cached_k;
    st->level -= (((st->level >> 9) * k) >> 7);
    if (st->level < 0) st->level = 0;
    int32_t out = sclamp_(ditherShift_(shaped * (st->level >> 5), 18));
    st->lp += onePoleStep((out << 12) - st->lp, (uint32_t)50000 << 16);
    int32_t hplp = st->hp;
    hplp += onePoleStep(st->lp - hplp, (uint32_t)400 << 16);
    st->hp = hplp;
    st->value = sclamp_(ditherShift_(st->lp - hplp, 12));
}

void OP_FN(op_snare)(struct Slot* s) {
    struct SnareState* st = (struct SnareState*)s->out;
    int32_t trig = s->in0 ? slot_in0(s) : 0;
    if (RISING_(trig, st->last_trig)) {
        st->level = SMAX_ << 12;
        st->pitchEnv = 1 << 15;
    }
    st->last_trig = trig;
    if (st->rng == 0) st->rng = rngSeed_((int)s->param0);
    int32_t note   = s->in1 ? slot_in1(s) : 45;
    int32_t decay  = vclamp_(s->in2 ? slot_in2(s) : VMID_);
    int32_t snappy = vclamp_(s->in3 ? slot_in3(s) : VMID_);
    int32_t tone   = vclamp_(s->in4 ? slot_in4(s) : VMID_);
    uint32_t inc1 = pitch_table[note & 0x7F];
    if (!inc1) inc1 = 11705314u;
    int32_t pe = st->pitchEnv;
    inc1 += umulhi32(inc1, (uint32_t)pe << 16) * 4;
    st->pitchEnv = (pe * 65468) >> 16;
    uint32_t inc2 = inc1 + (inc1 >> 1);
    st->phase += inc1;
    st->pos   += inc2;
    int32_t body = (sineInterp_(st->phase) + sineInterp_(st->pos)) >> 1;
    if (decay != st->cached_decay || !st->cached_k) { st->cached_k = drumDecayK_(decay, 10, 48); st->cached_decay = decay; }
    int32_t k = st->cached_k;
    st->level -= (((st->level >> 9) * k) >> 7); if (st->level < 0) st->level = 0;
    int32_t ampB = st->level >> 12;
    int32_t ampN = (ampB * ampB) >> 11;
    st->rng = xorshift32_(st->rng);
    int32_t noise = (int32_t)(st->rng >> (32 - VBITS_)) - VMID_;
    uint32_t kc = (uint32_t)((tone < 1 ? 1 : tone) << (16 - VBITS_));
    st->lp1 += onePoleStep((noise << 12) - st->lp1, kc << 16);
    int32_t hpn = noise - (st->lp1 >> 12);
    st->lp2 += onePoleStep((hpn << 12) - st->lp2, kc << 16);
    int32_t hp = st->lp2 >> 12;
    int32_t gB = ditherShift_(body * (st->level >> 5), 18);
    int32_t gN = (hp * ampN) >> 11;
    st->value = sclamp_(gB + (((gN - gB) * snappy) >> VBITS_));
}

void OP_FN(op_hat)(struct Slot* s) {
    struct HatState* st = (struct HatState*)s->out;
    int32_t trig = s->in0 ? slot_in0(s) : 0;
    if (RISING_(trig, st->last_trig)) st->level = SMAX_ << 12;
    st->last_trig = trig;
    int32_t note  = s->in1 ? slot_in1(s) : 81;
    int32_t decay = vclamp_(s->in2 ? slot_in2(s) : 1200);
    int32_t tone  = vclamp_(s->in3 ? slot_in3(s) : 2600);
    uint32_t inc1 = pitch_table[note & 0x7F];
    if (!inc1) inc1 = 93642516u;
    uint32_t inc2 = inc1 + umulhi32(inc1, 1932735283u);
    uint32_t inc3 = inc1 + umulhi32(inc1, 2662881724u);
    st->p1 += inc1;
    st->p2 += inc2;
    st->p3 += inc3;
    uint32_t p1 = st->p1, p2 = st->p2, p3 = st->p3;
    int32_t metal = ((p1 & 0x80000000u) ? 1 : -1)
                  + ((p2 & 0x80000000u) ? 1 : -1)
                  + ((p3 & 0x80000000u) ? 1 : -1)
                  + (((p1 + p2) & 0x80000000u) ? 1 : -1)
                  + (((p2 + p3) & 0x80000000u) ? 1 : -1)
                  + (((p1 + p3) & 0x80000000u) ? 1 : -1);
    int32_t sig = metal * 340;
    uint32_t kc = (uint32_t)((tone < 1 ? 1 : tone) << (16 - VBITS_));
    st->hp += ((((sig << 12) - st->hp) >> 10) * (int32_t)kc) >> 6;
    int32_t hp = sig - (st->hp >> 12);
    if (decay != st->cached_decay || !st->cached_k) { st->cached_k = drumDecayK_(decay, 10, 24); st->cached_decay = decay; }
    int32_t k = st->cached_k;
    st->level -= (((st->level >> 9) * k) >> 7); if (st->level < 0) st->level = 0;
    st->value = sclamp_(ditherShift_(hp * (st->level >> 5), 18));
}

/* ===== voices kernels ===== */

void OP_FN(op_envelope)(struct Slot* s) {
    struct EnvelopeState* st = (struct EnvelopeState*)s->out;
    int32_t trig  = s->in0 ? slot_in0(s) : 0;
    int32_t decay = vclamp_(s->in1 ? slot_in1(s) : VMID_);
    int32_t peak = (int32_t)s->param0;
    if (peak <= 0 || peak > VMAX_) peak = VMAX_;
    if (RISING_(trig, st->last_trig)) st->level = peak << 8;
    st->last_trig = trig;
    if (decay != st->cached_decay || !st->cached_k) { st->cached_k = drumDecayK_(decay, 10, 48); st->cached_decay = decay; }
    int32_t k = st->cached_k;
    st->level -= (((st->level >> 9) * k) >> 7);
    if (st->level < 0) st->level = 0;
    st->value = st->level >> 8;
}

void OP_FN(op_follow)(struct Slot* s) {
    struct FollowState* st = (struct FollowState*)s->out;
    /* Derived clock: in0 is the base clock's 12-bit ramp (0..4095, one turn per
     * base period) — the ordinary value every form exchanges, so this reads through
     * an `if`/any routing with no private phase channel. The output is a PURE
     * FUNCTION of how many base turns have elapsed (mod div) and the base's
     * within-turn phase: no integrator to drift, no alignment offset to mis-fire.
     * `counter` tracks base turns mod div; out = (counter*4096 + base)*mult/div, a
     * 12-bit ramp that wraps mult times per div base-turns. A /N first wraps on the
     * Nth base turn (the honest division); a *M wraps M times per base turn. */
    uint32_t base = (uint32_t)(s->in0 ? slot_in0(s) : 0) & 0xFFFu;
    uint32_t mult = (s->param0 & 0xFFFFu) ? (s->param0 & 0xFFFFu) : 1u;
    uint32_t div  = (s->param0 >> 16) ? (s->param0 >> 16) : 1u;
    if (base < st->last_base) {                /* base turned over */
        st->counter++;
        if (st->counter >= div) st->counter = 0;
    }
    st->last_base = base;
    /* :drift (in1, 0 when unwired) is a slow per-sample phase creep so a derived
       clock slides against its base over many seconds. Accumulate in 32 bits and
       take the top 12, so a small per-sample drift moves the ramp gently. */
    st->acc += (uint32_t)(*(const int32_t*)s->in1);
    uint32_t num = (st->counter * 4096u + base) * mult;
    uint32_t out = ((num / div) + (st->acc >> 20)) & 0xFFFu;
    st->value = (int32_t)out;
    /* follow outputs only its ramp; a consumer that wants the divided beat
       edge-detects it (rising through the low threshold), as for any clock. */
}

/* ===== tape kernels ===== */

void OP_FN(op_step)(struct Slot* s) {
    struct StepState*  st  = (struct StepState*)s->out;
    struct Buffer*     buf = (struct Buffer*)s->in0;
    int32_t clk = *(const int32_t*)s->in1;
    if (buf->length == 0) { st->last_clk = clk; st->value = st->cached; return; }
    /* :len caps the loop length: a literal lands in param0, a stream (e.g. a knob)
       in in2. in2 defaults to g_zero (0 = no cap) so plain `step` is unchanged. */
    int32_t dynlen = *(const int32_t*)s->in2;
    uint32_t len = s->param0 ? (uint32_t)s->param0
                 : (dynlen > 0) ? (uint32_t)dynlen
                 : (uint32_t)buf->length;
    if (len > (uint32_t)buf->length) len = (uint32_t)buf->length;   /* never read past the tape */
    if (FALLING_(clk, st->last_clk)) {
        uint32_t pos = (uint32_t)st->counter;
        if (pos >= len) pos = 0;   /* a shrunk dynamic :len can leave pos past the window */
        st->cached = pack12_read(buf->bytes, pos);
        pos++; if (pos >= len) pos = 0;
        st->counter = (int32_t)pos;
    }
    st->last_clk = clk;
    st->value = st->cached;
}
void OP_FN(op_lookup)(struct Slot* s) {
    struct LookupState* st  = (struct LookupState*)s->out;
    struct Buffer*      buf = (struct Buffer*)s->in0;
    int32_t idx = *(const int32_t*)s->in1;
    if (buf->length == 0) { st->value = 0; return; }
    /* :len caps the read window: a literal lands in param0, a stream in in2. */
    int32_t dynlen = *(const int32_t*)s->in2;
    uint32_t len = s->param0 ? (uint32_t)s->param0
                 : (dynlen > 0) ? (uint32_t)dynlen
                 : (uint32_t)buf->length;
    if (len > (uint32_t)buf->length) len = (uint32_t)buf->length;   /* never read past the tape */
    uint32_t pos = (len > 0) ? ((uint32_t)idx % len) : 0;
    st->value = pack12_read(buf->bytes, pos);
}
void OP_FN(op_wave)(struct Slot* s) {
    struct WaveState* st  = (struct WaveState*)s->out;
    struct Buffer*          buf = (struct Buffer*)s->in0;
    int32_t pos = *(const int32_t*)s->in1;
    uint32_t len = (uint32_t)buf->length;
    if (len == 0) { st->value = 0; return; }
    uint32_t len1 = len - 1u;
    int32_t P = pos * (int32_t)len1;
    int32_t idx_r = (P * 2 + (int32_t)VMAX_) / ((int32_t)VMAX_ * 2);
    int32_t P_mod = P % (int32_t)VMAX_;
    if (P_mod < 0) P_mod += (int32_t)VMAX_;
    int32_t frac_q16 = (P_mod << 16) / (int32_t)VMAX_;
    /* clamp+wrap by compare (no power-of-two requirement, so any buffer length). */
    if (idx_r < 0) idx_r = 0;
    if ((uint32_t)idx_r >= len) idx_r = (int32_t)len - 1;
    uint32_t p0 = (uint32_t)idx_r;
    uint32_t p1 = p0 + 1u; if (p1 >= len) p1 = 0u;
    int32_t a = pack12_read_signed(buf->bytes, p0);
    int32_t b = pack12_read_signed(buf->bytes, p1);
    int32_t v_q16 = a * 65536 + (b - a) * frac_q16;
    int32_t out;
    if (v_q16 >= 0) out = (v_q16 + 32768) >> 16;
    else            out = -(((-v_q16) + 32767) >> 16);
    st->value = out;
}
void OP_FN(op_tap)(struct Slot* s) {
    struct TapState* st  = (struct TapState*)s->out;
    struct Buffer*   buf = (struct Buffer*)s->in0;
    int32_t amount  = *(const int32_t*)s->in1;
    int32_t cur_head = *(const int32_t*)s->in2;
    uint32_t len = (uint32_t)buf->length;
    if (len == 0) { st->value = 0; return; }
    int32_t offset;
    if (s->param0 & 1u) {
        int32_t P = amount * (int32_t)(len - 1u);
        offset = (P * 2 + (int32_t)VMAX_) / ((int32_t)VMAX_ * 2);
        if (offset < 0) offset = 0;
        if (offset > (int32_t)(len - 1u)) offset = (int32_t)(len - 1u);
    } else {
        offset = amount;
        if (offset < 0) offset = 0;
        if (offset > (int32_t)(len - 1u)) offset = (int32_t)(len - 1u);
    }
    /* Wrap by compare-and-subtract: cur_head is in [0,len) and offset in
       [0,len-1], so one add of len covers a negative result. No power-of-two
       requirement, so the ring can be the full pool length. */
    int32_t readPos = cur_head - offset;
    if (readPos < 0) readPos += (int32_t)len;
    st->value = pack12_read_signed(buf->bytes, (uint32_t)readPos);
}
void OP_FN(op_recordhead_per_sample)(struct Slot* s) {
    struct RecordheadPerSampleState* st  = (struct RecordheadPerSampleState*)s->out;
    int32_t      val = *(const int32_t*)s->in0;
    struct Buffer* buf = (struct Buffer*)s->in1;
    st->value = val;
    /* param0 bit0: gated by in2 (:when). Freeze (no write/advance) while low. */
    if ((s->param0 & 1u) && *(const int32_t*)s->in2 <= VMID_) return;
    uint32_t len = (uint32_t)buf->length;
    uint32_t next = st->head_pos + 1u;
    if (next >= len) next = 0u;
    st->pending_pos           = st->head_pos;
    st->pending_val           = val;
    st->pending_head_pos_next = next;
    st->pending_valid         = 1;
}
void OP_FN(op_recordhead_per_cell)(struct Slot* s) {
    struct RecordheadPerCellState* st  = (struct RecordheadPerCellState*)s->out;
    int32_t      val = *(const int32_t*)s->in0;
    struct Buffer* buf = (struct Buffer*)s->in1;
    int32_t      clk = *(const int32_t*)s->in2;
    uint32_t len = (uint32_t)buf->length;
    if (FALLING_(clk, st->last_clk)) {
        uint32_t next = st->head_pos + 1u;
        if (next >= len) next = 0u;
        st->pending_pos           = st->head_pos;
        st->pending_val           = val;
        st->pending_head_pos_next = next;
        st->pending_valid         = 1;
    }
    st->last_clk = clk;
    st->value = val;
    (void)buf;
}
void OP_FN(op_recordhead_gated)(struct Slot* s) {
    struct RecordheadGatedState* st  = (struct RecordheadGatedState*)s->out;
    int32_t      val  = *(const int32_t*)s->in0;
    struct Buffer* buf = (struct Buffer*)s->in1;
    int32_t      gate = *(const int32_t*)s->in2;
    int32_t      clk  = *(const int32_t*)s->in3;
    uint32_t len = (uint32_t)buf->length;
    if (FALLING_(clk, st->last_clk) && gate > VMID_) {
        uint32_t next = st->head_pos + 1u;
        if (next >= len) next = 0u;
        st->pending_pos           = st->head_pos;
        st->pending_val           = val;
        st->pending_head_pos_next = next;
        st->pending_valid         = 1;
    }
    st->last_clk = clk;
    st->value = val;
    (void)buf;
}
void OP_FN(op_recordhead_len_capped)(struct Slot* s) {
    struct RecordheadLenCappedState* st  = (struct RecordheadLenCappedState*)s->out;
    int32_t      val = *(const int32_t*)s->in0;
    struct Buffer* buf = (struct Buffer*)s->in1;
    int32_t      clk;
    uint32_t cap;
    if (s->param0) {
        cap = (uint32_t)s->param0;
        clk = *(const int32_t*)s->in2;
    } else {
        int32_t len_val = *(const int32_t*)s->in2;
        cap = (len_val > 0) ? (uint32_t)len_val : (uint32_t)buf->length;
        clk = *(const int32_t*)s->in3;
    }
    if (cap > (uint32_t)buf->length) cap = (uint32_t)buf->length;
    if (cap == 0) cap = 1;
    /* A shrunk dynamic cap can leave head_pos outside the loop window; snap it back. */
    if (st->head_pos >= cap) st->head_pos = 0;
    if (FALLING_(clk, st->last_clk)) {
        st->pending_pos           = st->head_pos;
        st->pending_val           = val;
        st->pending_head_pos_next = (st->head_pos + 1u) % cap;
        st->pending_valid         = 1;
    }
    st->last_clk = clk;
    st->value = val;
    (void)buf;
}
void OP_FN(op_recordhead_len_capped_gated)(struct Slot* s) {
    struct RecordheadLenCappedGatedState* st  = (struct RecordheadLenCappedGatedState*)s->out;
    int32_t      val  = *(const int32_t*)s->in0;
    struct Buffer* buf = (struct Buffer*)s->in1;
    int32_t      gate = *(const int32_t*)s->in2;
    int32_t      clk  = *(const int32_t*)s->in3;
    uint32_t cap = s->param0 ? s->param0 : (uint32_t)buf->length;
    if (cap > (uint32_t)buf->length) cap = (uint32_t)buf->length;
    if (cap == 0) cap = 1;
    if (st->head_pos >= cap) st->head_pos = 0;
    if (FALLING_(clk, st->last_clk) && gate > VMID_) {
        st->pending_pos           = st->head_pos;
        st->pending_val           = val;
        st->pending_head_pos_next = (st->head_pos + 1u) % cap;
        st->pending_valid         = 1;
    }
    st->last_clk = clk;
    st->value = val;
    (void)buf;
}
void OP_FN(op_seek)(struct Slot* s) {
    struct SeekState* st  = (struct SeekState*)s->out;
    struct Buffer*    buf = (struct Buffer*)s->in0;
    int32_t idx = *(const int32_t*)s->in1;
    if (buf->length == 0) { st->value = 0; return; }
    /* :len caps the window; literal only on seek (param0), not a stream. */
    uint32_t len = s->param0 ? (uint32_t)s->param0 : (uint32_t)buf->length;
    if (len > (uint32_t)buf->length) len = (uint32_t)buf->length;
    uint32_t pos = (uint32_t)idx % len;
    st->value = pack12_read(buf->bytes, pos);
}
void OP_FN(op_onsets)(struct Slot* s) {
    struct OnsetsState* st  = (struct OnsetsState*)s->out;
    struct Buffer*      buf = (struct Buffer*)s->in0;
    int32_t clk = *(const int32_t*)s->in1;
    if (FALLING_(clk, st->last_clk)) {
        uint32_t len = (uint32_t)buf->length;
        if (len > 0) {
            uint32_t pos = (uint32_t)st->counter;
            int32_t cell = pack12_read(buf->bytes, pos);
            if (cell != 0) st->pulseLeft = kTickWidth;
            pos++; if (pos >= len) pos -= len;
            st->counter = (int32_t)pos;
        }
    }
    st->last_clk = clk;
    if (st->pulseLeft > 0) { st->pulseLeft--; st->value = VMAX_; }
    else st->value = 0;
}
void OP_FN(op_gates)(struct Slot* s) {
    struct GatesState* st  = (struct GatesState*)s->out;
    struct Buffer*     buf = (struct Buffer*)s->in0;
    int32_t clk = *(const int32_t*)s->in1;
    if (FALLING_(clk, st->last_clk)) {
        uint32_t len = (uint32_t)buf->length;
        if (len > 0) {
            uint32_t pos = (uint32_t)st->counter;
            int32_t cell = pack12_read(buf->bytes, pos);
            st->gate = (cell != 0) ? VMAX_ : 0;
            pos++; if (pos >= len) pos -= len;
            st->counter = (int32_t)pos;
        }
    }
    st->last_clk = clk;
    st->value = st->gate;
}
void OP_FN(op_hits)(struct Slot* s) {
    struct HitsState* st  = (struct HitsState*)s->out;
    struct Buffer*    buf = (struct Buffer*)s->in0;
    int32_t clk = *(const int32_t*)s->in1;
    if (FALLING_(clk, st->last_clk)) {
        uint32_t len = (uint32_t)buf->length;
        if (len > 0) {
            uint32_t pos = (uint32_t)st->step_count % len;
            st->cached = pack12_read(buf->bytes, pos);
            st->step_count++;
        }
    }
    st->last_clk = clk;
    st->value = st->cached;
}
void OP_FN(op_degree)(struct Slot* s) {
    struct DegreeState* st  = (struct DegreeState*)s->out;
    int32_t val = *(const int32_t*)s->in0;
    struct Buffer* buf = (struct Buffer*)s->in1;
    uint32_t len = (uint32_t)buf->length;
    if (len == 0) {
        st->value = (val * 127) / (VMAX_ + 1);
        return;
    }
    int32_t idx    = (val * (int32_t)len) / (VMAX_ + 1);
    int32_t octave = idx / (int32_t)len;
    int32_t deg    = idx % (int32_t)len;
    if (deg < 0) { deg += (int32_t)len; octave--; }
    int32_t cell = pack12_read(buf->bytes, (uint32_t)deg);
    int32_t note = 48 + octave * 12 + cell;
    if (note > 127) note = 127;
    if (note < 0)   note = 0;
    st->value = note;
}
void OP_FN(op_pitch)(struct Slot* s) {
    struct PitchState* st  = (struct PitchState*)s->out;
    int32_t val = *(const int32_t*)s->in0;
    struct Buffer* buf = (struct Buffer*)s->in1;
    uint32_t len = (uint32_t)buf->length;
    int32_t note;
    if (len == 0) {
        note = (val * 127) / (VMAX_ + 1);
    } else {
        int32_t idx    = (val * (int32_t)len) / (VMAX_ + 1);
        int32_t octave = idx / (int32_t)len;
        int32_t deg    = idx % (int32_t)len;
        if (deg < 0) { deg += (int32_t)len; octave--; }
        int32_t cell = pack12_read(buf->bytes, (uint32_t)deg);
        note = 48 + octave * 12 + cell;
        if (note > 127) note = 127;
        if (note < 0)   note = 0;
    }
    st->value = js_round_div(note * VMAX_, 127);   /* MIDI 127 -> VMAX */
}
void OP_FN(op_thru)(struct Slot* s) {
    struct ThruState* st  = (struct ThruState*)s->out;
    struct Buffer*    buf = (struct Buffer*)s->in0;
    uint32_t len = (uint32_t)buf->length;
    if (len == 0) { st->value = 0; return; }
    int32_t idx = *(const int32_t*)s->in1;
    if (idx < 0) idx = 0;
    if ((uint32_t)idx >= len) idx = (int32_t)(len - 1u);
    st->value = pack12_read(buf->bytes, (uint32_t)idx);
}
void OP_FN(op_wave_drumrack)(struct Slot* s) {
    struct WaveDrumrackState* st  = (struct WaveDrumrackState*)s->out;
    struct Buffer*            buf = (struct Buffer*)s->in0;
    uint32_t len = (uint32_t)buf->length;
    if (len == 0) { st->value = 0; return; }
    st->value = pack12_read(buf->bytes, st->phase);
    st->phase++;
    if (st->phase >= len) st->phase -= len;
}

/* ===== terminal write + stub ===== */

void OP_FN(op_terminal_write)(struct Slot* s) {
    *(int32_t*)s->out = *(const int32_t*)s->in0;
}

/* ===== KFN table (kid -> RAM-resident fn pointer) ===== */
/* The table itself may live in flash: it is read only at apply time, not
 * on the hot path.  The functions it points to are in RAM. */

/* op_* forward declarations not needed — all defined above in this file. */

/* KFN uses plain symbol names; the OP_FN decorator on the definitions
 * places those symbols in RAM already. */
static void (* const KFN[KID_COUNT])(struct Slot*) = {
    /* 0 */ op_add,
    /* 1 */ op_sub,
    /* 2 */ op_mul,
    /* 3 */ op_div,
    /* 4 */ op_mod,
    /* 5 */ op_spread,
    /* 6 */ op_gt,
    /* 7 */ op_gte,
    /* 8 */ op_lt,
    /* 9 */ op_lte,
    /* 10 */ op_eq,
    /* 11 */ op_ne,
    /* 12 */ op_if,
    /* 13 */ op_not,
    /* 14 */ op_max,
    /* 15 */ op_min,
    /* 16 */ op_abs,
    /* 17 */ op_rect,
    /* 18 */ op_and,
    /* 19 */ op_or,
    /* 20 */ op_xor,
    /* 21 */ op_v_oct,
    /* 22 */ op_knob,
    /* 23 */ op_cv_in,
    /* 24 */ op_audio_in,
    /* 25 */ op_pulse_in,
    /* 26 */ op_switch,
    /* 27 */ op_detent,
    /* 28 */ op_phasor,
    /* 29 */ op_sine,
    /* 30 */ op_triangle,
    /* 31 */ op_saw,
    /* 32 */ op_square,
    /* 33 */ 0, /* reserved */
    /* 34 */ op_edge,
    /* 35 */ op_fall,
    /* 36 */ op_diff,
    /* 37 */ op_toggle,
    /* 38 */ op_hold,
    /* 39 */ op_gate,
    /* 40 */ op_schmitt,
    /* 41 */ op_z1,
    /* 42 */ op_vca,
    /* 43 */ op_ring,
    /* 44 */ op_mix2,
    /* 45 */ op_lpf,
    /* 46 */ op_hpf,
    /* 47 */ 0, /* reserved */
    /* 48 */ op_average,
    /* 49 */ op_slew,
    /* 50 */ op_vcf,
    /* 51 */ op_noise,
    /* 52 */ op_random,
    /* 53 */ op_chance,
    /* 54 */ op_walk,
    /* 55 */ op_lpg,
    /* 56 */ op_envfollow,
    /* 57 */ op_wavefold,
    /* 58 */ op_crush,
    /* 59 */ op_mix,
    /* 60 */ op_window,
    /* 61 */ op_range,
    /* 62 */ op_connected,
    /* 63 */ op_cv,
    /* 64 */ op_snap,
    /* 65 */ op_quantise,
    /* 66 */ op_every,
    /* 67 */ op_euclid,
    /* 68 */ op_envelope,
    /* 69 */ op_follow,
    /* 70 */ op_kick,
    /* 71 */ op_snare,
    /* 72 */ op_hat,
    /* 73 */ op_step,
    /* 74 */ op_lookup,
    /* 75 */ op_wave,
    /* 76 */ op_tap,
    /* 77 */ op_recordhead_per_sample,
    /* 78 */ op_recordhead_per_cell,
    /* 79 */ op_recordhead_gated,
    /* 80 */ op_recordhead_len_capped,
    /* 81 */ op_recordhead_len_capped_gated,
    /* 82 */ op_seek,
    /* 83 */ op_onsets,
    /* 84 */ op_gates,
    /* 85 */ op_hits,
    /* 86 */ op_degree,
    /* 87 */ op_pitch,
    /* 88 */ op_thru,
    /* 89 */ op_saturate,
    /* 90 */ op_transpose,
    /* 91 */ op_invert,
    /* 92 */ op_shift,
    /* 93 */ op_mask,
    /* 94 */ op_bit,
    /* 95 */ op_feedback,
    /* 96 */ op_add_sat,
    /* 97 */ op_len,
    /* 98 */ op_record,
    /* 99 */ op_turns,
    /* 100 */ op_counter,
    /* 101 */ op_sub_sat,
    /* 102 */ 0, /* reserved */
    /* 103 */ op_wave_drumrack,
    /* 104 */ op_morph,
    /* 105 */ op_terminal_write,
};
_Static_assert(sizeof(KFN) / sizeof(KFN[0]) == KID_COUNT,
               "KFN entry count must equal KID_COUNT");

/* Called once per slot at apply time to wire the fn pointer. */
void runtime_slot_wire_fn(struct Slot* s) {
    uint8_t kid = s->kernel_id;
    s->fn = (kid < KID_COUNT) ? KFN[kid] : NULL;
}

/* Per-kernel NodeState size = sizeof the struct the kernel casts to. The C struct
 * is the single source of truth for state layout. Kernels with no struct (pure
 * value ops) default to 4 (value). */
static const uint16_t KSTATE_BYTES[KID_COUNT] = {
    [KID_OP_AUDIO_IN]                     = sizeof(struct LeafState),
    [KID_OP_AVERAGE]                      = sizeof(struct OnePoleState),
    [KID_OP_CHANCE]                       = sizeof(struct ChanceState),
    [KID_OP_COUNTER]                      = sizeof(struct CounterState),
    [KID_OP_CRUSH]                        = sizeof(struct CrushState),
    [KID_OP_CV_IN]                        = sizeof(struct LeafState),
    [KID_OP_DEGREE]                       = sizeof(struct DegreeState),
    [KID_OP_DETENT]                       = sizeof(struct LeafState),
    [KID_OP_DIFF]                         = sizeof(struct DiffState),
    [KID_OP_EDGE]                         = sizeof(struct EdgeState),
    [KID_OP_ENVELOPE]                     = sizeof(struct EnvelopeState),
    [KID_OP_ENVFOLLOW]                    = sizeof(struct EnvFollowState),
    [KID_OP_EUCLID]                       = sizeof(struct EuclidState),
    [KID_OP_EVERY]                        = sizeof(struct EveryState),
    [KID_OP_FALL]                         = sizeof(struct FallState),
    [KID_OP_FOLLOW]                       = sizeof(struct FollowState),
    [KID_OP_GATE]                         = sizeof(struct GateState),
    [KID_OP_GATES]                        = sizeof(struct GatesState),
    [KID_OP_HAT]                          = sizeof(struct HatState),
    [KID_OP_HITS]                         = sizeof(struct HitsState),
    [KID_OP_HOLD]                         = sizeof(struct HoldState),
    [KID_OP_KICK]                         = sizeof(struct KickState),
    [KID_OP_KNOB]                         = sizeof(struct LeafState),
    [KID_OP_LOOKUP]                       = sizeof(struct LookupState),
    [KID_OP_LPF]                          = sizeof(struct OnePoleState),
    [KID_OP_LPG]                          = sizeof(struct LpgState),
    [KID_OP_NOISE]                        = sizeof(struct NoiseState),
    [KID_OP_ONSETS]                       = sizeof(struct OnsetsState),
    [KID_OP_PHASOR]                       = sizeof(struct PhasorState),
    [KID_OP_PITCH]                        = sizeof(struct PitchState),
    [KID_OP_PULSE_IN]                     = sizeof(struct LeafState),
    [KID_OP_RANDOM]                       = sizeof(struct RandomState),
    [KID_OP_RECORDHEAD_GATED]             = sizeof(struct RecordheadGatedState),
    [KID_OP_RECORDHEAD_LEN_CAPPED]        = sizeof(struct RecordheadLenCappedState),
    [KID_OP_RECORDHEAD_LEN_CAPPED_GATED]  = sizeof(struct RecordheadLenCappedGatedState),
    [KID_OP_RECORDHEAD_PER_CELL]          = sizeof(struct RecordheadPerCellState),
    [KID_OP_RECORDHEAD_PER_SAMPLE]        = sizeof(struct RecordheadPerSampleState),
    [KID_OP_SAW]                          = sizeof(struct SawState),
    [KID_OP_SCHMITT]                      = sizeof(struct SchmittState),
    [KID_OP_SEEK]                         = sizeof(struct SeekState),
    [KID_OP_SINE]                         = sizeof(struct SineState),
    [KID_OP_SLEW]                         = sizeof(struct OnePoleState),
    [KID_OP_SNARE]                        = sizeof(struct SnareState),
    [KID_OP_SQUARE]                       = sizeof(struct SquareState),
    [KID_OP_STEP]                         = sizeof(struct StepState),
    [KID_OP_SWITCH]                       = sizeof(struct LeafState),
    [KID_OP_TAP]                          = sizeof(struct TapState),
    [KID_OP_THRU]                         = sizeof(struct ThruState),
    [KID_OP_TOGGLE]                       = sizeof(struct ToggleState),
    [KID_OP_TRIANGLE]                     = sizeof(struct TriangleState),
    [KID_OP_TURNS]                        = sizeof(struct TurnsState),
    [KID_OP_VCF]                          = sizeof(struct VcfState),
    [KID_OP_WALK]                         = sizeof(struct WalkState),
    [KID_OP_WAVE]                         = sizeof(struct WaveState),
    [KID_OP_WAVE_DRUMRACK]                = sizeof(struct WaveDrumrackState),
    [KID_OP_WAVEFOLD]                     = sizeof(struct WavefoldState),
    [KID_OP_Z1]                           = sizeof(struct Z1State),
};

uint32_t runtime_kernel_state_bytes(uint8_t kid) {
    uint16_t b = (kid < KID_COUNT) ? KSTATE_BYTES[kid] : 0;
    return b ? b : 4u;   /* stateless: value only */
}

/* ===== KTABLE (name -> KID) ===== */

typedef struct { const char* name; uint8_t kid; } KEntry;

static const KEntry KTABLE[] = {
    {"op_add",    KID_OP_ADD},
    {"op_sub",    KID_OP_SUB},
    {"op_add_sat",KID_OP_ADD_SAT},
    {"op_sub_sat",KID_OP_SUB_SAT},
    {"op_mul",    KID_OP_MUL},
    {"op_div",    KID_OP_DIV},
    {"op_mod",    KID_OP_MOD},
    {"op_spread", KID_OP_SPREAD},
    {"op_gt",     KID_OP_GT},
    {"op_gte",    KID_OP_GTE},
    {"op_lt",     KID_OP_LT},
    {"op_lte",    KID_OP_LTE},
    {"op_eq",     KID_OP_EQ},
    {"op_ne",     KID_OP_NE},
    {"op_if",     KID_OP_IF},
    {"op_not",    KID_OP_NOT},
    {"op_max",    KID_OP_MAX},
    {"op_min",    KID_OP_MIN},
    {"op_abs",    KID_OP_ABS},
    {"op_rect",   KID_OP_RECT},
    {"op_and",    KID_OP_AND},
    {"op_or",     KID_OP_OR},
    {"op_xor",    KID_OP_XOR},
    {"op_v_oct",  KID_OP_V_OCT},
    {"op_knob",       KID_OP_KNOB},
    {"op_cv_in",      KID_OP_CV_IN},
    {"op_audio_in",   KID_OP_AUDIO_IN},
    {"op_pulse_in",   KID_OP_PULSE_IN},
    {"op_switch", KID_OP_SWITCH},
    {"op_detent",     KID_OP_DETENT},
    {"op_phasor",   KID_OP_PHASOR},
    {"op_sine",     KID_OP_SINE},
    {"op_triangle", KID_OP_TRIANGLE},
    {"op_saw",      KID_OP_SAW},
    {"op_square",   KID_OP_SQUARE},
    {"op_trig",   KID_OP_EDGE},
    {"op_edge",   KID_OP_EDGE},
    {"op_fall",   KID_OP_FALL},
    {"op_diff",   KID_OP_DIFF},
    {"op_toggle", KID_OP_TOGGLE},
    {"op_hold",   KID_OP_HOLD},
    {"op_gate",   KID_OP_GATE},
    {"op_schmitt",KID_OP_SCHMITT},
    {"op_z1",     KID_OP_Z1},
    {"op_vca",    KID_OP_VCA},
    {"op_ring",   KID_OP_RING},
    {"op_mix2",   KID_OP_MIX2},
    {"op_lpf",    KID_OP_LPF},
    {"op_hpf",    KID_OP_HPF},
    {"op_average",KID_OP_AVERAGE},
    {"op_slew",   KID_OP_SLEW},
    {"op_vcf",    KID_OP_VCF},
    {"op_noise",  KID_OP_NOISE},
    {"op_random", KID_OP_RANDOM},
    {"op_chance", KID_OP_CHANCE},
    {"op_walk",   KID_OP_WALK},
    {"op_lpg",    KID_OP_LPG},
    {"op_envfollow",KID_OP_ENVFOLLOW},
    {"op_wavefold",KID_OP_WAVEFOLD},
    {"op_crush",   KID_OP_CRUSH},
    {"op_saturate",KID_OP_SATURATE},
    {"op_mix",    KID_OP_MIX},
    {"op_window", KID_OP_WINDOW},
    {"op_range",  KID_OP_RANGE},
    {"op_cv",     KID_OP_CV},
    {"op_snap",   KID_OP_SNAP},
    {"op_quantise",KID_OP_QUANTISE},
    {"op_every",  KID_OP_EVERY},
    {"op_euclid", KID_OP_EUCLID},
    {"op_envelope",KID_OP_ENVELOPE},
    {"op_follow", KID_OP_FOLLOW},
    {"op_kick",   KID_OP_KICK},
    {"op_snare",  KID_OP_SNARE},
    {"op_hat",    KID_OP_HAT},
    {"op_step",   KID_OP_STEP},
    {"op_lookup", KID_OP_LOOKUP},
    {"op_wave",KID_OP_WAVE},
    {"op_tap",    KID_OP_TAP},
    {"op_recordhead_per_sample",        KID_OP_RECORDHEAD_PER_SAMPLE},
    {"op_recordhead_per_cell",          KID_OP_RECORDHEAD_PER_CELL},
    {"op_recordhead_gated",             KID_OP_RECORDHEAD_GATED},
    {"op_recordhead_len_capped",        KID_OP_RECORDHEAD_LEN_CAPPED},
    {"op_recordhead_len_capped_gated",  KID_OP_RECORDHEAD_LEN_CAPPED_GATED},
    {"op_seek",   KID_OP_SEEK},
    {"op_onsets", KID_OP_ONSETS},
    {"op_gates",  KID_OP_GATES},
    {"op_hits",   KID_OP_HITS},
    {"op_degree", KID_OP_DEGREE},
    {"op_pitch",  KID_OP_PITCH},
    {"op_thru",   KID_OP_THRU},
    {"op_transpose", KID_OP_TRANSPOSE},
    {"op_invert",    KID_OP_INVERT},
    {"op_shift",     KID_OP_SHIFT},
    {"op_mask",      KID_OP_MASK},
    {"op_bit",       KID_OP_BIT},
    {"op_feedback",  KID_OP_FEEDBACK},
    {"op_len",       KID_OP_LEN},
    {"op_record",    KID_OP_RECORD},
    {"op_turns",     KID_OP_TURNS},
    {"op_counter",   KID_OP_COUNTER},
    {"op_connected", KID_OP_CONNECTED},
    {"op_wave_drumrack",    KID_OP_WAVE_DRUMRACK},
    {"op_morph",            KID_OP_MORPH},
    {"op_add2",  KID_OP_ADD},
    {"op_mul2",  KID_OP_MUL},
    {"op_or2",   KID_OP_OR},
    {"op_and2",  KID_OP_AND},
    {"op_terminal_write_audio_out_1", KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_audio_out_2", KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_cv_out_1",    KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_cv_out_2",    KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_pulse_out_1", KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_pulse_out_2", KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_led_0",       KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_led_1",       KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_led_2",       KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_led_3",       KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_led_4",       KID_OP_TERMINAL_WRITE},
    {"op_terminal_write_led_5",       KID_OP_TERMINAL_WRITE},
    {NULL, KID_UNKNOWN}
};

uint8_t runtime_find_kernel(const char* name) {
    for (int i = 0; KTABLE[i].name; i++)
        if (strcmp(KTABLE[i].name, name) == 0)
            return KTABLE[i].kid;
    return KID_UNKNOWN;
}

int runtime_is_hw_leaf(uint8_t kid) {
    return (kid == KID_OP_KNOB || kid == KID_OP_CV_IN || kid == KID_OP_AUDIO_IN ||
            kid == KID_OP_PULSE_IN || kid == KID_OP_SWITCH);
}

/* ===== recordhead helpers ===== */

static void __not_in_flash_func(recordhead_commit_pending)(struct Slot* s) {
    struct RecordheadCommon* rc = (struct RecordheadCommon*)s->out;
    if (!rc->pending_valid) return;
    struct Buffer* buf = (struct Buffer*)s->in1;
    rc->pending_valid = 0;
    if (rc->pending_pos >= (uint32_t)buf->length) return;  /* empty/sentinel buffer or stale pos: no write */
    pack12_write(buf->bytes, rc->pending_pos, rc->pending_val);
    rc->head_pos     = rc->pending_head_pos_next;
    rc->head_pos_out = (int32_t)rc->pending_head_pos_next;
}

static inline int is_recordhead_kid(uint8_t kid) {
    return (uint8_t)(kid - KID_OP_RECORDHEAD_PER_SAMPLE)
         <= (KID_OP_RECORDHEAD_LEN_CAPPED_GATED - KID_OP_RECORDHEAD_PER_SAMPLE);
}

void recordhead_sweep(struct LensRuntime* rt) {
    if (!rt->has_recordhead) return;  /* common case: no delay/buffer writes */
    for (uint16_t i = 0; i < rt->slot_count; i++) {
        if (is_recordhead_kid(rt->slots[i].kernel_id))
            recordhead_commit_pending(&rt->slots[i]);
    }
}

/* ===== hw scratch ===== */

static int32_t hw_scratch[10];

void __not_in_flash_func(runtime_update_hw_scratch)(const struct HardwareInputs* hw) {
    hw_connected = hw->connected;
    hw_scratch[0] = hw->audio_in_1;
    hw_scratch[1] = hw->audio_in_2;
    hw_scratch[2] = hw->pulse_in_1;
    hw_scratch[3] = hw->pulse_in_2;
    hw_scratch[4] = hw->cv_in_1;
    hw_scratch[5] = hw->cv_in_2;
    hw_scratch[6] = hw->knob_main;
    hw_scratch[7] = hw->knob_x;
    hw_scratch[8] = hw->knob_y;
    hw_scratch[9] = hw->switch_pos;
}

int32_t* runtime_hw_jack_ptr(uint32_t idx) {
    return &hw_scratch[idx < 10 ? idx : 9];
}

/* ===== step functions ===== */

/* Run one slot. Every slot runs every sample (the synchronous model): pure ops
 * recompute from their inputs, stateful ops self-gate on their own clock/edge, so
 * there is nothing to skip. (The old skip-on-unchanged check cost ~half the per-slot
 * floor and almost never fired on the audio path, where inputs change every sample.) */
static inline void step_slot(struct Slot* s) {
    if (s->fn) s->fn(s);
}

void runtime_step(struct LensRuntime* rt,
                  const struct HardwareInputs* hw,
                  struct HardwareOutputs* hw_out) {
    runtime_update_hw_scratch(hw);
    for (uint16_t i = 0; i < rt->slot_count; i++)
        step_slot(&rt->slots[i]);
    recordhead_sweep(rt);
    runtime_drive_terminals(rt, hw_out);
    rt->sample_counter++;
}

/* Oracle: every slot once per sample in walk order, in place. The optimized
 * runtime is diffed against this. */
void runtime_step_reference(struct LensRuntime* rt,
                            const struct HardwareInputs* hw,
                            struct HardwareOutputs* hw_out) {
    runtime_update_hw_scratch(hw);
    for (uint16_t i = 0; i < rt->slot_count; i++) {
        struct Slot* s = &rt->slots[i];
        if (s->fn) s->fn(s);
    }
    recordhead_sweep(rt);
    runtime_drive_terminals(rt, hw_out);
    rt->sample_counter++;
}

void __not_in_flash_func(runtime_drive_terminals)(struct LensRuntime* rt,
                                                   struct HardwareOutputs* hw_out) {
    hw_out->cv_out_1_is_pitch = 0;
    hw_out->cv_out_2_is_pitch = 0;
    for (uint8_t i = 0; i < rt->terminal_count; i++) {
        uint16_t wi = rt->terminals[i].slot_walk_idx;
        if (wi >= rt->slot_count) continue;
        int32_t* p   = (int32_t*)rt->slots[wi].out;
        int32_t  val = *p;
        /* v/oct pitch jack (mode 1): the value is a MIDI note. Clamp to 0..127
           (saturate at the rails, like a real CV) so any out-of-range tape cell or
           transposed note is safe; main.cpp then outputs calibrated 1V/oct. */
        int      is_pitch = (rt->terminals[i].mode == 1);
        int32_t  pitch_val = is_pitch ? (int32_t)midi_clamp(val) : val;
        switch (rt->terminals[i].jack_id) {
            case LENS_JACK_AUDIO_OUT_1: hw_out->audio_out_1 = val; break;
            case LENS_JACK_AUDIO_OUT_2: hw_out->audio_out_2 = val; break;
            case LENS_JACK_CV_OUT_1:    hw_out->cv_out_1 = pitch_val; hw_out->cv_out_1_is_pitch = (uint8_t)is_pitch; break;
            case LENS_JACK_CV_OUT_2:    hw_out->cv_out_2 = pitch_val; hw_out->cv_out_2_is_pitch = (uint8_t)is_pitch; break;
            case LENS_JACK_PULSE_OUT_1: hw_out->pulse_out_1 = val; break;
            case LENS_JACK_PULSE_OUT_2: hw_out->pulse_out_2 = val; break;
            case LENS_JACK_LED_0:       hw_out->led_0       = val; break;
            case LENS_JACK_LED_1:       hw_out->led_1       = val; break;
            case LENS_JACK_LED_2:       hw_out->led_2       = val; break;
            case LENS_JACK_LED_3:       hw_out->led_3       = val; break;
            case LENS_JACK_LED_4:       hw_out->led_4       = val; break;
            case LENS_JACK_LED_5:       hw_out->led_5       = val; break;
            default: break;
        }
    }
}

void __not_in_flash_func(runtime_publish_shadows)(struct LensRuntime* rt) {
    for (uint16_t i = 0; i < rt->xcore_count; i++)
        lens_shadow_pool[i] = *rt->xcore_src[i];
}

void runtime_destroy(struct LensRuntime* rt) { (void)rt; }


void __not_in_flash_func(runtime_step_core0)(struct LensRuntime* rt,
                                              const struct HardwareInputs* hw,
                                              struct HardwareOutputs* hw_out) {
    runtime_update_hw_scratch(hw);
    uint32_t seq = rt->sample_counter;
    runtime_walk_core0(rt, seq);
    recordhead_sweep(rt);
    runtime_publish_shadows(rt);
    runtime_drive_terminals(rt, hw_out);
    rt->sample_counter++;
}

void __not_in_flash_func(runtime_walk_core0)(struct LensRuntime* rt, uint32_t seq) {
    (void)seq;
    struct Slot** const end = rt->core0_slots + rt->core0_count;
    for (struct Slot** p = rt->core0_slots; p < end; p++) step_slot(*p);
}

void __not_in_flash_func(runtime_walk_core1)(struct LensRuntime* rt, uint32_t seq) {
    (void)seq;
    struct Slot** const end = rt->core1_slots + rt->core1_count;
    for (struct Slot** p = rt->core1_slots; p < end; p++) step_slot(*p);
}
