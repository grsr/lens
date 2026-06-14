// loupe.h: the runtime interpreter. Synchronous dataflow graph at 48 kHz.
// Reads see the previous sample's committed value (shadow: write `next`,
// commit at sample end), so a forward reference is a one-sample feedback
// delay with no special case. Values are 12-bit at rest, 32-bit in flight;
// the jack decides what a value means.

#pragma once

#include <stdint.h>
#include "tape.h"
#include "expression.h"
#include "osc_table.h"   // kSineTable[256] for the osc nodes

// Functions in the audio interrupt path must live in RAM (XIP miss = stall).
// Apply to non-inline functions on the per-sample path; inline kernels get
// pinned transitively through their caller.
#define LENS_AUDIO_HOT __not_in_flash_func

namespace loupe {

// Panel/jack readings the interpreter reads per sample (Core 0 writes).
struct InputSnapshot
{
    int32_t knob_main, knob_x, knob_y;
    int32_t master_x, master_y;
    int32_t cv_in[2];
    bool    pulse_in[2];
    bool    connected[6];                     // Audio1,2 CV1,2 Pulse1,2
    int8_t  active_page;                      // 0..3 sequence, 4 master
    int8_t  switch_pos;                       // Z-switch: 0 down, 1 mid, 2 up
};

struct Context
{
    uint8_t*             live;
    Tape*                tapes;
    const InputSnapshot* in;
    int32_t              spb;
    const uint32_t*      pitch_table;
    const uint32_t*      rate_table;
    const uint32_t*      ratio_table;
    int32_t              audio_in[2];
    int32_t              catch_up_steps = 1;   // samples this recompute stands for (>1 = Core 1 catch-up)
};

// Read tape `t`'s element at (pos + offset), wrapping within the tape.
inline int32_t ReadTapeAt(const Context& ctx, int t, int32_t pos, int32_t offset)
{
    const Tape& tp = ctx.tapes[t];
    if (tp.length == 0) return 0;
    int32_t p = pos + offset;
    const int32_t L = (int32_t)tp.length;
    if (p >= L) { p -= L; if (p >= L) p %= L; }
    else if (p < 0) { p += L; if (p < 0) { p %= L; if (p < 0) p += L; } }
    return ReadElem(ctx.live, (int)tp.start, p);
}

// Per-node runtime scratch (parallel to Expression.nodes[]).
// 12-bit at rest, 32-bit in flight; shadow: write `next`, commit at sample end.
struct NodeState
{
    int32_t  value;        // committed output read by downstream (PREVIOUS sample)
    int32_t  next;         // this sample's fresh result; committed to value at sample end
    int32_t  level;
    uint32_t phase;
    uint32_t pos;
    int32_t  aux0;
    int32_t  aux1;
    int32_t  aux2;
    uint8_t  last_clock;   // for rising-edge detection on clock_from
    uint32_t wraps;        // phasor turn count; tick-gated generators self-gate on this
    int32_t  clk_seen;     // monotonic clock this node last acted on (catch up by delta)
};

struct ExprState
{
    NodeState* nodes;       // base of the bound slice (nullptr/0 = unbound)
    uint16_t   cap;         // slots bound to this state (= Graph.length)
};

// Reset an expression's runtime state (boot / patch apply).
inline void ResetExprState(ExprState& s)
{
    for (int i = 0; i < s.cap; ++i)
        s.nodes[i] = NodeState{ /*value*/0, /*next*/0, /*level*/0,
                                /*phase*/0u, /*pos*/0u, /*aux0*/0, /*aux1*/0, /*aux2*/0,
                                /*last_clock*/0, /*wraps*/0u, /*clk_seen*/0 };
}

// Resolve a Tape handle to a (start, length) region. Hardware tape or literal (kLiteralBase + n).
struct TapeRegion { int32_t start; int32_t length; };

inline TapeRegion ResolveRegion(const Graph& expr, const Context& ctx, int array_idx)
{
    if (array_idx >= kLiteralBase)
    {
        int li = array_idx - kLiteralBase;
        if (li >= 0 && li < expr.literal_count)
            return { (int32_t)expr.literals[li].start, (int32_t)expr.literals[li].length };
        return { 0, 0 };
    }
    if (array_idx >= 0 && array_idx < kMaxTapes)
        return { (int32_t)ctx.tapes[array_idx].start, (int32_t)ctx.tapes[array_idx].length };
    return { 0, 0 };
}

// Deterministic xorshift32 (sim == firmware bit-exact).
inline uint32_t XorShift32(uint32_t& s) { uint32_t x = s ? s : 1u; x ^= x << 13; x ^= x >> 17; x ^= x << 5; s = x; return x; }
inline uint32_t RngSeed(int i)           { return (0x9E3779B9u ^ ((uint32_t)i * 0x6D2B79F5u)) | 1u; }

// Value -> CV DAC (-2048..2047). mode 0 = unipolar, mode 1 = bipolar (VMID = 0V).
inline int32_t CvToDac(int32_t v, int32_t mode)
{
    v = vclamp(v);
    if (mode == 1) return v - VMID;
    return (v * SMAX) / VMAX;
}

// Expansive waveshaper (decode half of companding): square-law magnitude, bipolar around VMID.
inline int32_t Expand(int32_t byte)
{
    int32_t x = (byte & VMASK) - VMID;
    int32_t m = x < 0 ? -x : x;
    int32_t mag = ((m * m) >> (VBITS - 1)) * SMAX >> (VBITS - 1);
    return x < 0 ? -mag : mag;
}

// Pulse width in samples for gate of length `len` (0..VMAX) at `spb` samples/beat.
inline int32_t PulseWidth(int32_t len, int32_t spb, int32_t trig_floor)
{
    int32_t w = (int32_t)(((uint32_t)spb * (uint32_t)(len & VMASK)) >> VBITS);
    return (w < trig_floor) ? trig_floor : w;
}

// Node handlers. Named functions so Recompute reads as a flat list.

// Step-per-cycle head position: pos = clock.wraps mod len.
inline int32_t HeadPos(ExprState& s, int clock_from, int32_t len)
{
    if (clock_from < 0 || len <= 0) return 0;
    return (int32_t)(s.nodes[clock_from].wraps % (uint32_t)len);
}

// 32x32 -> high 32 bits, inline (M0+ has no UMULL).
static inline uint32_t umulhi32(uint32_t a, uint32_t b)
{
    uint32_t ah = a >> 16, al = a & 0xFFFF, bh = b >> 16, bl = b & 0xFFFF;
    uint32_t lo  = al * bl;
    uint32_t m1  = ah * bl + (lo >> 16);
    uint32_t m2  = al * bh + (m1 & 0xFFFF);
    return ah * bh + (m1 >> 16) + (m2 >> 16);
}

// One-pole step at full precision: diff * (coefQ32 / 2^32). No dead-zone, no 64-bit.
static inline int32_t onePoleStep(int32_t diff, uint32_t coefQ32)
{
    uint32_t mag  = diff < 0 ? (uint32_t)(-diff) : (uint32_t)diff;
    int32_t  step = (int32_t)umulhi32(mag, coefQ32);
    return diff < 0 ? -step : step;
}

// Q16 multiply: equivalent to (int32_t)(((int64_t)a * b) >> 16), no 64-bit ops.
// a must be non-negative and < 2^17; loses at most 1 ULP at Q16 resolution.
static inline int32_t q16Mul(int32_t a, int32_t b)
{
    uint32_t mag = (b < 0) ? (uint32_t)(-b) : (uint32_t)b;
    uint32_t prod = umulhi32((uint32_t)a << 15, mag) << 1;   // (a<<15)*|b| >> 32 <<1 == a*|b| >> 16
    return (b < 0) ? -(int32_t)prod : (int32_t)prod;
}

// Narrow to 12-bit with 1-LSB TPDF dither added BEFORE the shift. hi==0 = true silence.
static inline int32_t ditherShift(int32_t hi, int shift)
{
    if (hi == 0) return 0;
    static uint32_t r = 0x2545F491u;
    r ^= r << 13; r ^= r >> 17; r ^= r << 5; int32_t a = (int32_t)(r >> (32 - shift));
    r ^= r << 13; r ^= r >> 17; r ^= r << 5; int32_t b = (int32_t)(r >> (32 - shift));
    return (hi + a + b - (1 << shift)) >> shift;
}

// Interpolated sine of a 32-bit phase: 256-entry LUT, linear between entries (~+-SMAX).
static inline int32_t interpSine(uint32_t ph)
{
    int32_t i = (int32_t)(ph >> 24), frac = (int32_t)((ph >> 16) & 0xFF);
    int32_t a = kSineTable[i], b = kSineTable[(i + 1) & 0xFF];
    return a + (((b - a) * frac) >> 8);
}

// Continuous per-sample head position for audio tapes (delay lines, samplers): spread(phase, len).
inline int32_t WriteHead(ExprState& s, int clock_from, int32_t len)
{
    if (clock_from < 0 || len <= 0) return 0;
    return (int32_t)umulhi32(s.nodes[clock_from].phase, (uint32_t)len);
}

// Recordhead write gate: fires once per tick on the position just left. First call arms (no write).
struct RecGate { int32_t pos; uint32_t wraps; int32_t last; uint8_t seen; };
inline bool RecAdvanced(RecGate& g, int32_t pos, uint32_t wraps)
{
    bool adv = g.seen && !(g.pos == pos && g.wraps == wraps);
    g.seen = 1; g.pos = pos; g.wraps = wraps;
    return adv;
}

inline int32_t opArrange(const Graph& expr, ExprState& state, const Context& ctx, int i, bool advance)
{
    const Node& f = expr.nodes[i];
    TapeRegion prog = ResolveRegion(expr, ctx, f.array_idx);
    if (prog.length < 1) return 0;
    NodeState& st = state.nodes[i];
    int N = (int)f.param;
    int32_t v = 0;
    if (N == 0)
    {
        // concat whole tapes end to end
        uint32_t total = 0;
        for (int s = 0; s < prog.length; ++s) {
            int tgt = ReadElem(ctx.live, (int)prog.start, s);
            if (tgt >= 0 && tgt < kMaxTapes) total += ctx.tapes[tgt].length;
        }
        if (total < 1) return 0;
        uint32_t p = st.pos % total, rem = p;
        for (int s = 0; s < prog.length; ++s) {
            int tgt = ReadElem(ctx.live, (int)prog.start, s);
            uint32_t tl = (tgt >= 0 && tgt < kMaxTapes) ? ctx.tapes[tgt].length : 0;
            if (rem < tl) { v = ReadElem(ctx.live, (int)ctx.tapes[tgt].start, (int)rem); break; }
            rem -= tl;
        }
        if (advance) st.pos = (p + 1) % total;
    }
    else
    {
        // fixed N-element slices in program order
        uint32_t P = (uint32_t)prog.length, step = st.pos;
        int slot = (int)((step / (uint32_t)N) % P);
        int tgt  = ReadElem(ctx.live, (int)prog.start, slot);
        if (tgt >= 0 && tgt < kMaxTapes && ctx.tapes[tgt].length > 0) {
            uint32_t tl = ctx.tapes[tgt].length;
            uint32_t off = (f.branch_count != 0)
                ? ((step / ((uint32_t)N * P)) * (uint32_t)N + (step % (uint32_t)N))   // advancing
                : (step % (uint32_t)N);                                               // reset (cut)
            v = ReadElem(ctx.live, (int)ctx.tapes[tgt].start, (int)(off % tl));
        }
        if (advance) st.pos = step + 1;
    }
    return v;
}

// lookup: read tape[index]. clock_from >= 0 = clock-indexed step-per-cycle; else explicit `a`.
inline int32_t opLookup(const Graph& expr, ExprState& s, const Context& ctx, int i, int32_t a)
{
    const Node& f = expr.nodes[i];
    TapeRegion r = ResolveRegion(expr, ctx, f.array_idx);
    if (r.length <= 0) return 0;
    int32_t idx;
    if (f.clock_from >= 0) {
        idx = (int32_t)(s.nodes[f.clock_from].wraps % (uint32_t)r.length);
    } else {
        idx = a % r.length; if (idx < 0) idx += r.length;
    }
    return ReadElem(ctx.live, (int)r.start, idx);
}

inline int32_t opShift(const Graph& expr, ExprState& s, const Context& ctx, int i, int32_t a)
{
    const Node& f = expr.nodes[i];
    const Node& src = expr.nodes[f.in_a];
    if (src.kind == NODE_LOOKUP && src.array_idx >= 0 && src.array_idx < kMaxTapes)
        return ReadTapeAt(ctx, src.array_idx, HeadPos(s, src.clock_from, ctx.tapes[src.array_idx].length), (int32_t)f.param);
    return a;
}

// tap: delay-line read, `offset` samples behind the write head. :interp = gliding fractional tap.
static constexpr int kTapGlide = 4;

inline int32_t opTap(const Graph& e, ExprState& s, const Context& ctx, int idx)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    if (f.array_idx < 0 || f.array_idx >= kMaxTapes) return 0;
    int32_t wh = WriteHead(s, f.clock_from, ctx.tapes[f.array_idx].length);
    if (f.param_from < 0)
        return v2sig(ReadTapeAt(ctx, f.array_idx, wh, -(int32_t)f.param));   // fixed delay

    int32_t off = (int32_t)s.nodes[f.param_from].value;
    // :span maps 12-bit control across the whole tape
    if (f.param & 2) off = (int32_t)(((int64_t)off * (int32_t)ctx.tapes[f.array_idx].length) >> VBITS);
    if (!(f.param & 1))
        return v2sig(ReadTapeAt(ctx, f.array_idx, wh, -off));

    // :interp: fractional glided read. st.phase = current offset in Q24.8.
    int32_t target = off << 8;
    st.phase = (uint32_t)((int32_t)st.phase + (((target - (int32_t)st.phase)) >> kTapGlide));
    int32_t fl   = (int32_t)st.phase >> 8;
    int32_t frac = (int32_t)st.phase & 0xFF;
    int32_t a = ReadTapeAt(ctx, f.array_idx, wh, -fl);
    int32_t b = ReadTapeAt(ctx, f.array_idx, wh, -(fl + 1));
    return v2sig(a + (((b - a) * frac) >> 8));
}

// noise: white noise (bipolar). hold > 1 = sample-and-hold.
inline int32_t opNoise(ExprState& s, int i, int32_t hold)
{
    NodeState& st = s.nodes[i];
    if (st.phase == 0) st.phase = RngSeed(i);
    if (hold > 1)
    {
        if (st.pos == 0) { st.level = (int32_t)(XorShift32(st.phase) >> (32 - VBITS)) - VMID; st.pos = (uint32_t)hold; }
        st.pos--;
        return st.level;
    }
    return (int32_t)(XorShift32(st.phase) >> (32 - VBITS)) - VMID;   // 0..VMAX -> bipolar
}

// crush: sample-rate reduction. Holds input, re-sampling every N samples (N from param_from or const param).
inline int32_t opCrush(const Graph& e, ExprState& s, int idx)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    int32_t n = (f.param_from >= 0) ? (int32_t)s.nodes[f.param_from].value : (int32_t)f.param;
    if (n < 1) n = 1;
    if ((int32_t)st.pos <= 0)                                                       // re-sample the input
    { st.level = (f.in_a >= 0) ? s.nodes[f.in_a].value : 0; st.pos = (uint32_t)n; }
    st.pos--;
    return st.level;                                                                // hold between samples
}

// vcf: Chamberlin SVF (LP/HP/BP/notch via param). cutoff = in_b, resonance = param_from (0..VMAX).
// State in Q(kVcfQ) for sub-LSB resolution; stable to ~fs/6.
inline int32_t opVcf(const Graph& e, ExprState& s, int idx)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    int32_t in  = (f.in_a >= 0) ? s.nodes[f.in_a].value : 0;
    int32_t cut = (f.in_b >= 0) ? (int32_t)s.nodes[f.in_b].value : VMAX;
    int32_t res = (f.param_from >= 0) ? (int32_t)s.nodes[f.param_from].value : 0;
    cut = vclamp(cut); res = vclamp(res);
    int32_t f1 = cut << 4;                                   // Q16 cutoff coeff
    int32_t q1 = (VMAX - res) << 5;                          // Q16 damping
    const int kVcfQ = 12;
    int32_t inq  = in << kVcfQ;
    int32_t low = st.level, band = st.aux0;
    int32_t high = inq - low - q16Mul(q1, band);
    band += q16Mul(f1, high);
    const int32_t kLim = 1 << 25;                            // saturate rather than blow up
    if (band > kLim) band = kLim; else if (band < -kLim) band = -kLim;
    low += q16Mul(f1, band);
    if (low > kLim) low = kLim; else if (low < -kLim) low = -kLim;
    st.level = low; st.aux0 = band;
    // param picks band: 0 LP, 1 HP, 2 BP, 3 notch
    int32_t out;
    switch (f.param) { case 1: out = high; break; case 2: out = band; break;
                       case 3: out = low + high; break; default: out = low; }
    return sclamp(out >> kVcfQ);
}

inline int32_t opSwitch(const Graph& expr, ExprState& state, int i, int32_t a)
{
    const Node& f = expr.nodes[i];
    if (f.branch_count <= 0) return 0;
    int32_t active = a % f.branch_count; if (active < 0) active += f.branch_count;
    int bidx = f.branch_start + active;
    if (bidx < 0 || bidx >= i) return 0;
    // Carry the active branch's clock state too, so (if/switch/normal) over clocks
    // works as expected: downstream tick/step/onsets read switch.wraps and see the
    // chosen branch's ticks.
    state.nodes[i].wraps = state.nodes[bidx].wraps;
    state.nodes[i].phase = state.nodes[bidx].phase;
    return state.nodes[bidx].value;
}

inline int32_t opKnob(const Node& f, const Context& ctx)
{
    if (!ctx.in) return 0;
    int32_t kv = 0;
    switch (f.param) {
        case 0: kv = ctx.in->knob_main; break;   // :main
        case 1: kv = ctx.in->knob_x;    break;   // :x / :variety
        case 2: kv = ctx.in->knob_y;    break;   // :y
        case 3: kv = ctx.in->master_x;  break;   // :master-x
        case 4: kv = ctx.in->master_y;  break;   // :master-y
    }
    return vclamp(kv);                        // a knob is a value
}

inline int32_t opCvIn(const Node& f, const Context& ctx)
{
    if (!ctx.in) return 0;
    int32_t cvv = ctx.in->cv_in[(((uint8_t)f.param & 0x3F) == 2) ? 1 : 0];
    int32_t v;
    if ((uint8_t)f.param & 0x40) {            // :v-oct -> a MIDI note, ~1V/oct, >=4 octaves
        v = 48 + (cvv >> 5);                  // centred on C3 (cvv 0); +-64 semitones, tolerant
        if (v > 127) v = 127; else if (v < 0) v = 0;
    } else {                                  // raw control value
        v = vclamp(sig2v(cvv));               // ±2048 CV-in -> value (the audio->control bridge)
    }
    return v;
}

// Self-gate: true if the node's monotonic clock has advanced since it last acted.
inline bool clockAdvanced(NodeState& st, int32_t clk) { bool a = (clk != st.clk_seen); st.clk_seen = clk; return a; }

// counter: bar number, advancing once per tick. Catches up by full delta if deferred.
inline int32_t opCounter(ExprState& state, int i, int32_t param, int32_t clk)
{
    int32_t barlen = (param > 0) ? param : 1;
    NodeState& st = state.nodes[i];
    int32_t v = vwrap((int32_t)(st.pos / (uint32_t)barlen));
    if (clk != st.clk_seen) { int32_t d = clk - st.clk_seen; if (d > 0) st.pos += (uint32_t)d; st.clk_seen = clk; }
    return v;
}

// edge: rising edge of `a` (threshold VMID/2) -> one-eval VMAX pulse.
inline int32_t opEdge(ExprState& state, int i, int32_t a)
{
    NodeState& st = state.nodes[i];
    int32_t high = (a > VMID) ? 1 : 0;
    int32_t v = (high && st.last_clock == 0) ? VMAX : 0;
    st.last_clock = (uint8_t)high;
    return v;
}

// diff: x minus its previous evaluated value (slope). First eval yields x (aux0 starts 0).
inline int32_t opDiff(ExprState& state, int i, int32_t a)
{
    NodeState& st = state.nodes[i];
    int32_t d = a - st.aux0;
    st.aux0 = a;
    return d;
}

// toggle: T flip-flop; flips aux0 (0<->VMAX) on each rising edge of `a`.
inline int32_t opToggle(ExprState& state, int i, int32_t a)
{
    NodeState& st = state.nodes[i];
    int32_t high = (a > VMID) ? 1 : 0;
    if (high && st.last_clock == 0) st.aux0 = st.aux0 ? 0 : VMAX;
    st.last_clock = (uint8_t)high;
    return st.aux0;
}

// schmitt: comparator with hysteresis. Latches high above hi, low below lo, holds between.
inline int32_t opSchmitt(ExprState& state, int i, int32_t x, int32_t lo, int32_t hi)
{
    NodeState& st = state.nodes[i];
    if (st.aux0 == 0) { if (x > hi) st.aux0 = 1; }
    else              { if (x < lo) st.aux0 = 0; }
    return st.aux0 ? VMAX : 0;
}

// hold: sample-and-hold. On rising trigger (in_b), latches in_a; signal inputs sampled via sig2v.
inline int32_t opHold(const Graph& expr, ExprState& state, int i, int32_t a, int32_t b)
{
    const Node& f = expr.nodes[i]; NodeState& st = state.nodes[i];
    int32_t val = (f.in_a >= 0 && expr.nodes[f.in_a].is_signal)
                ? sig2v(state.nodes[f.in_a].value) : a;
    val = vclamp(val);
    int32_t high = (b > VMID) ? 1 : 0;
    if (high && st.last_clock == 0) st.level = val;
    st.last_clock = (uint8_t)high;
    return st.level;
}

// random: new value per clock tick; held between (st.level).
inline int32_t opRandom(const Graph& expr, ExprState& state, int i, bool advance)
{
    const Node& f = expr.nodes[i];
    NodeState& st = state.nodes[i];
    if (st.phase == 0) st.phase = RngSeed(i);
    if (advance) {
        uint32_t r = XorShift32(st.phase);
        int32_t shape = (f.param_from >= 0) ? state.nodes[f.param_from].value : (int32_t)f.param;
        int32_t u = (int32_t)(r >> (32 - VBITS));                   // uniform 0..VMAX
        if (shape > 140) u = (u + (int32_t)((r >> 8) & VMASK)) >> 1; // triangular distribution
        st.level = u;
    }
    return st.level;
}

inline int32_t opWalk(const Graph& expr, ExprState& state, int i, bool advance)
{
    const Node& f = expr.nodes[i];
    NodeState& st = state.nodes[i];
    if (st.phase == 0) { st.phase = RngSeed(i); st.level = VMID; }   // start mid
    if (advance) {
        uint32_t r = XorShift32(st.phase);
        int32_t step = (int32_t)f.param; if (step < 1) step = 1;
        int32_t s = (int32_t)((r >> 24) % (uint32_t)(2 * step + 1)) - step;   // -step..+step
        st.level = vwrap(st.level + s);
    }
    return st.level;
}


// ---------------------------------------------------------------------------
// Signal terminal render (per sample). Level is Q12 so slow slews resolve sub-LSB.
// ---------------------------------------------------------------------------
static constexpr int32_t kSlewQ = 12;
inline int32_t SlewStep(int32_t p, int32_t spb)         // Q12 / sample
{
    if (p <= 0) return SMAX << kSlewQ;
    int32_t t = (spb * (p + 1)) >> 5; if (t < 1) t = 1;
    int32_t s = (SMAX << kSlewQ) / t; return s < 1 ? 1 : s;
}
inline int32_t EnvDecayK(int32_t p, int32_t spb)         // one-pole coeff Q16; p in 1/16-beat units
{
    int32_t tau = (spb * p) >> 6;
    if (tau < 1) return 65535;                          // p ~ 0 -> instant (a click)
    int32_t k = 65536 / tau; return k < 1 ? 1 : (k > 65535 ? 65535 : k);
}

// Operand reads. rd: raw previous-sample value (works for signal or value).
// sg: as a signal (0 for non-signal inputs).
inline int32_t rd(ExprState& s, int x) { return x >= 0 ? s.nodes[x].value : 0; }
inline int32_t sg(const Graph& e, ExprState& s, int x) { return (x >= 0 && e.nodes[x].is_signal) ? s.nodes[x].value : 0; }

// Rising edge of a clock_from node (signal crosses 0, value crosses VMID). Updates `last` in place.
inline bool RisingEdgeOf(const Graph& e, ExprState& s, int clock_from, uint8_t& last)
{
    int32_t sc  = e.nodes[clock_from].is_signal ? sg(e, s, clock_from) : (int32_t)s.nodes[clock_from].value;
    int32_t mid = e.nodes[clock_from].is_signal ? 0 : VMID;
    bool high = sc > mid, rise = high && last == 0;
    last = high ? 1 : 0;
    return rise;
}

inline int32_t opAudioSlew(const Graph& e, ExprState& s, int idx, int32_t spb)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    int32_t target = v2u(f.in_a >= 0 ? s.nodes[f.in_a].value : 0) << kSlewQ;
    int32_t rate = (f.param_from >= 0) ? s.nodes[f.param_from].value : (int32_t)f.param;
    int32_t step = SlewStep(rate, spb);
    if      (st.level < target) { st.level += step; if (st.level > target) st.level = target; }
    else if (st.level > target) { st.level -= step; if (st.level < target) st.level = target; }
    return st.level >> kSlewQ;
}

// envelope: AD (:trig, array_idx 0) or AHD (:gate, 1). in_a = peak; param = decay rate.
inline int32_t opAudioEnvelope(const Graph& e, ExprState& s, int idx, int32_t spb, bool triggered)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    int32_t peak = (f.in_a >= 0) ? (int32_t)s.nodes[f.in_a].value : VMAX;
    int32_t src  = (f.clock_from >= 0) ? (int32_t)s.nodes[f.clock_from].value : (triggered ? VMAX : 0);
    bool high = src > VMID, rise = high && st.last_clock == 0;
    st.last_clock = high ? 1 : 0;
    // decay: literal in 1/16-beat units, or stream (0..VMAX -> 0..64 sixteenths)
    int32_t d = (f.param_from >= 0) ? (s.nodes[f.param_from].value >> 6) : (int32_t)f.param;
    int32_t k = EnvDecayK(d, spb);
    if (f.array_idx == 1)
    {
        if (high) st.level = v2u(peak) << kSlewQ;                 // AHD: hold high
        else      st.level -= (((st.level >> 9) * k) >> 7);        // AHD: release
    }
    else
    {
        if (rise) st.level = v2u(peak) << kSlewQ;                 // AD: attack on rise
        st.level -= (((st.level >> 9) * k) >> 7);                  // AD: decay
    }
    if (st.level < 0) st.level = 0;
    return st.level >> kSlewQ;
}

// DPW band-limited saw (Valimaki 2005, after Chris Johnson). Square the phase ramp to a
// parabola, differentiate -> band-limited saw; divide by invc (= phase_incr>>15) to normalise.
static inline int32_t DpwSaw(int32_t signed_phase, int32_t& last_parab, int32_t invc)
{
    int32_t r    = signed_phase >> 16;
    int32_t para = r * r;
    int32_t diff = para - last_parab;
    last_parab   = para;
    return diff / invc;
}

// Phasor: 32-bit phase accumulator -> unipolar ramp (phase>>21, 0..SMAX). Four rate modes:
// NOTE (pitch LUT), RATE (log freq LUT), HZ (literal increment), TEMPO (0.25..~30 Hz slice).
// :tempo top MUST agree with intervals.js SLOW_SOURCE_HZ.
static constexpr int kTempoLoByte    = 32;   // rate_table[32]  ~ 0.25 Hz
static constexpr int kTempoSpanBytes = 94;   // rate_table[126] ~ 29 Hz

inline int32_t opAudioPhasor(const Graph& e, ExprState& s, int idx, const Context& ctx)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    uint32_t inc;
    switch (f.param & 3)
    {
        case 2: {                                                  // HZ: literal increment (cached in aux0/aux1)
            if (st.aux1 == 0)
            {
                // 32-bit increment packed as 3 x 12-bit values: e0 | (e1<<12) | (e2<<24)
                TapeRegion r = ResolveRegion(e, ctx, f.array_idx);
                st.aux0 = (int32_t)( (uint32_t)ReadElem(ctx.live, (int)r.start, 0)
                    | ((uint32_t)ReadElem(ctx.live, (int)r.start, 1) << 12)
                    | ((uint32_t)ReadElem(ctx.live, (int)r.start, 2) << 24) );
                st.aux1 = 1;
            }
            inc = (uint32_t)st.aux0;
            break;
        }
        case 1:                                                    // RATE: value -> log-freq LUT
            inc = ctx.rate_table ? ctx.rate_table[((f.in_a >= 0 ? s.nodes[f.in_a].value : 0) >> (VBITS - 8)) & 0xFF] : 0;
            break;
        case 3: {                                                  // TEMPO: 0.25..~30 Hz slice of rate LUT
            int32_t v = (f.in_a >= 0) ? vclamp(s.nodes[f.in_a].value) : VMID;
            inc = ctx.rate_table ? ctx.rate_table[kTempoLoByte + ((v * kTempoSpanBytes) >> VBITS)] : 0;
            break;
        }
        default:                                                   // NOTE: value -> pitch LUT
            inc = ctx.pitch_table ? ctx.pitch_table[(f.in_a >= 0 ? s.nodes[f.in_a].value : 36) & 0x7F] : 0;
            break;
    }
    if (f.in_b >= 0)                                               // :cents fine detune (±100 cents, linear approx)
    {
        int32_t fine = v2sig(s.nodes[f.in_b].value);
        inc += (uint32_t)(int32_t)(((int64_t)(int32_t)inc * fine * 30) >> 20);
    }
    // :phase offset in param bits 2..11 (1024 steps/turn); hard sync on clock_from rising edge.
    const uint32_t offs = ((uint32_t)((uint16_t)f.param >> 2) & 0x3FF) << 22;
    if (st.pos == 0) { st.phase = offs; st.pos = 1; }
    if (f.clock_from >= 0 && RisingEdgeOf(e, s, f.clock_from, st.last_clock)) st.phase = offs;
    st.level = (int32_t)inc;                                       // expose inc for DPW normalisation
    uint32_t prev = st.phase;
    st.phase += inc * (uint32_t)ctx.catch_up_steps;                         // ctx.catch_up_steps: dual-core catch-up
    if (st.phase < prev) st.wraps++;                               // turn count (tick generators self-gate on wraps)
    return (int32_t)(st.phase >> 21);
}

// follow: derived phasor at base rate × N (array_idx 0=mult, 1=div, 2=log-ratio).
// Exact integer ratios derive base's unwrapped phase (locked); param_from adds drift.
inline int32_t opAudioFollow(const Graph& e, ExprState& s, const Context& ctx, int idx)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    if (f.in_a < 0) return 0;
    const NodeState& bs = s.nodes[f.in_a];
    int32_t N = (int32_t)f.param; if (N == 0) N = 1;
    if (f.array_idx == 2)                                         // RATE: log ratio (centred 1.0x at VMID, +-1 oct)
    {
        int32_t ctrl  = (f.param_from >= 0) ? vclamp((int32_t)s.nodes[f.param_from].value) : VMID;
        uint32_t ratio = ctx.ratio_table ? ctx.ratio_table[(ctrl >> (VBITS - 8)) & 0xFF] : (1u << 16);  // Q16
        int32_t inc = (int32_t)(((int64_t)bs.level * ratio) >> 16);
        uint32_t prev = st.phase; st.phase += (uint32_t)(inc * ctx.catch_up_steps);
        if (st.phase < prev) st.wraps++;
        st.level = inc;
        return (int32_t)(st.phase >> 21);
    }
    if (f.param_from >= 0)                                         // bent ratio (drift): own accumulator
    {
        // nudge proportional to base.inc -> tempo-independent drift rate
        int32_t inc = (f.array_idx == 1) ? (bs.level / N) : (bs.level * N);
        inc += (int32_t)(((int64_t)bs.level * (int32_t)s.nodes[f.param_from].value) >> 16);
        uint32_t prev = st.phase; st.phase += (uint32_t)(inc * ctx.catch_up_steps);
        if (st.phase < prev) st.wraps++;
        st.level = inc;
        return (int32_t)(st.phase >> 21);
    }
    uint64_t baseTotal = ((uint64_t)bs.wraps << 32) | bs.phase;    // unwrapped base phase
    uint64_t total = (f.array_idx == 1) ? (baseTotal / (uint32_t)N)
                                        : (baseTotal * (uint32_t)N);
    st.phase = (uint32_t)total;
    st.wraps = (uint32_t)(total >> 32);
    st.level = (f.array_idx == 1) ? (bs.level / N) : (bs.level * N);  // expose derived inc
    return (int32_t)(st.phase >> 21);
}

// vclock: variable-step clock. Each step lasts dur(k) = linear map of the tape value over
// [kStepMin, kStepMax] samples. Phase sweeps 0..1 per loop; spread(phase,len) = current step.
static constexpr int32_t kStepMin = 2400;    // ~50 ms  at time value 0
static constexpr int32_t kStepMax = 28800;   // ~600 ms at time value VMAX
inline int32_t opVClock(const Graph& e, ExprState& s, const Context& ctx, int idx)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    TapeRegion r = ResolveRegion(e, ctx, f.array_idx);
    int32_t len = r.length; if (len < 1) return 0;
    int32_t step = (int32_t)umulhi32(st.phase, (uint32_t)len);                         // spread(phase, len)
    int32_t val  = ReadElem(ctx.live, (int)r.start, step);
    int32_t dur  = kStepMin + ((val * (kStepMax - kStepMin)) >> VBITS);
    if (dur < 1) dur = 1;
    // Both divides cached: slice (aux0/aux1) changes only on patch edit; inc (level/pos) only per step.
    if (st.aux1 != len)
    { st.aux0 = (int32_t)(uint32_t)(0x100000000ull / (uint32_t)len); st.aux1 = len; st.pos = 0; }
    if ((int32_t)st.pos != dur)
    {
        uint32_t i2 = (uint32_t)st.aux0 / (uint32_t)dur; if (i2 < 1) i2 = 1;
        st.level = (int32_t)i2;
        st.pos   = (uint32_t)dur;
    }
    uint32_t inc = (uint32_t)st.level;
    uint32_t prev = st.phase; st.phase += inc * (uint32_t)ctx.catch_up_steps;
    if (st.phase < prev) st.wraps++;
    return (int32_t)(st.phase >> 21);
}

// shape: param 0=sine, 1=tri, 2=saw (DPW), 3=square (DPW). in_a = pitch note or explicit phasor.
// in_b = FM/PM; array_idx = depth 0..127. clock_from = hard sync.
inline int32_t opAudioShape(const Graph& e, ExprState& s, int idx, const Context& ctx)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    uint32_t ph; int32_t inc;
    if (f.in_a >= 0 && e.nodes[f.in_a].kind == NODE_PHASOR)
    {
        ph  = s.nodes[f.in_a].phase;                              // explicit phasor: it advanced this sample
        inc = s.nodes[f.in_a].level;                              // its increment (for DPW invc)
    }
    else
    {
        if (f.clock_from >= 0 && RisingEdgeOf(e, s, f.clock_from, st.last_clock)) st.phase = 0;
        int32_t note = (f.in_a >= 0) ? s.nodes[f.in_a].value : -1;
        uint32_t base = (note >= 0 && ctx.pitch_table) ? ctx.pitch_table[note & 0x7F]
                                                       : 5852657u;             // ~C2
        inc = (int32_t)base;
        if (f.in_b >= 0 && !(f.param & 4))                        // :fm linear FM
        {
            int32_t mod = (e.nodes[f.in_b].is_signal) ? sg(e, s, f.in_b)
                                                          : v2sig(s.nodes[f.in_b].value);
            int32_t depth = (f.array_idx > 0) ? f.array_idx : 0;
            inc += (mod * depth) << 5;
        }
        if (inc < 0) inc = 0;
        st.phase += (uint32_t)(inc * ctx.catch_up_steps);
        ph = st.phase;
    }
    if ((f.param & 4) && f.in_b >= 0)                             // :pm phase modulation (DX-style)
    {
        int32_t mod = (e.nodes[f.in_b].is_signal) ? sg(e, s, f.in_b)
                                                  : v2sig(s.nodes[f.in_b].value);
        int32_t depth = (f.array_idx > 0) ? f.array_idx : 0;
        ph += (uint32_t)(((int64_t)mod * depth) << 13);
    }
    switch (f.param & 3)                                          // bit 2 = the PM flag
    {
        case 1: {                                                          // triangle
            int32_t q = (int32_t)(ph >> 16);                               // 0..65535
            int32_t tri = (q < 32768) ? (q - 16384) : (49152 - q);         // -16384..16384
            return (tri * SMAX) >> 14;
        }
        case 2: {                                                          // saw (DPW)
            int32_t invc = inc >> 15; if (invc < 1) invc = 1;
            int32_t v = (DpwSaw((int32_t)ph, st.aux0, invc) * 13) >> 8;  // ~0.8 SMAX headroom for BL overshoot
            return sclamp(v);
        }
        case 3: {                                                          // square/pulse: saw(phase) - saw(phase+width)
            // PWM: param_from sets duty (VMID=50%); absent -> fixed 50%.
            // DC midpoint subtracted to keep pulse symmetric across duty sweep.
            int32_t invc = inc >> 15; if (invc < 1) invc = 1;
            int32_t duty = VMID;
            uint32_t half = 0x80000000u;
            if (f.param_from >= 0)                                         // PWM from a stream
            {
                duty = e.nodes[f.param_from].is_signal ? (sg(e, s, f.param_from) + VMID)
                                                       : (int32_t)s.nodes[f.param_from].value;
                if (duty < 0) duty = 0; else if (duty > VMAX) duty = VMAX;
                half = (uint32_t)duty << (32 - VBITS);
            }
            int32_t a  = DpwSaw((int32_t)ph,          st.aux0, invc);
            int32_t b  = DpwSaw((int32_t)(ph + half), st.aux1, invc);
            int32_t dc = (VMID - duty) << 4;                              // cancel duty-dependent DC
            int32_t v  = (((a - b) - dc) * 13) >> 8;
            return sclamp(v);
        }
        default: {                                                         // sine (interpolated LUT)
            int32_t i0   = (int32_t)(ph >> 24);                            // 0..255
            int32_t frac = (int32_t)((ph >> 16) & 0xFF);
            int32_t a = kSineTable[i0], b = kSineTable[(i0 + 1) & 0xFF];
            return a + (((b - a) * frac) >> 8);
        }
    }
}

// wave: play a tape as audio. RAM-pinned to avoid XIP misses inside the audio interrupt.
inline int32_t opAudioWave(const Graph& e, ExprState& s, int idx, const Context& ctx)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    TapeRegion reg = ResolveRegion(e, ctx, f.array_idx);
    int32_t len = reg.length; if (len < 1) return 0;
    int32_t start = reg.start;
    // :slots N = drum rack: split into N equal hits, pick via param_from.
    int32_t slots = (f.branch_count > 1) ? (int32_t)f.branch_count : 1;
    int32_t cyc   = len / slots; if (cyc < 1) cyc = 1;
    // :once (param bit 4) = one-shot on rising clock_from edge; st.pos = playing flag.
    const bool once = (f.param & 4);
    // :scan (loop mode only): slides read window start by clock_from control value.
    int32_t scan = 0;
    if (once)
    {
        if (f.clock_from >= 0 && RisingEdgeOf(e, s, f.clock_from, st.last_clock)) { st.phase = 0; st.pos = 1; }
        if (!st.pos) return 0;
    }
    else if (f.clock_from >= 0)
    {
        int32_t sc = (e.nodes[f.clock_from].is_signal) ? u2v(sg(e, s, f.clock_from))
                                                           : (int32_t)s.nodes[f.clock_from].value;
        scan = vclamp(sc);
    }
    uint32_t inc = (f.in_a >= 0 && ctx.pitch_table) ? ctx.pitch_table[s.nodes[f.in_a].value & 0x7F]
                                                    : 5852657u;            // ~C2 drone
    uint32_t prev_phase = st.phase;
    inc *= (uint32_t)ctx.catch_up_steps;                                             // dual-core catch-up
    if (f.param & 1) st.phase -= inc; else st.phase += inc;                 // :reverse
    if (once)
    {
        bool wrapped = (f.param & 1) ? (st.phase > prev_phase) : (st.phase < prev_phase);
        if (wrapped) st.pos = 0;
    }
    int32_t i2   = (int32_t)umulhi32(st.phase, (uint32_t)cyc);
    int32_t frac = (int32_t)(((st.phase * (uint32_t)cyc) >> 24) & 0xFF);
    // param_from: picks hit slot (:slots) OR scrubs position (:pos). Mutually exclusive.
    int32_t base = 0, off = 0;
    if (slots > 1)
    {
        int32_t pick = (f.param_from >= 0) ? (((int32_t)s.nodes[f.param_from].value * slots) >> VBITS) : 0;
        if (pick < 0) pick = 0; else if (pick >= slots) pick = slots - 1;
        base = pick * cyc;
    }
    else off = (f.param_from >= 0) ? (((int32_t)s.nodes[f.param_from].value * len) >> VBITS) : 0;
    int32_t idx2 = (i2 + off) % cyc;
    int32_t a = ReadElem(ctx.live, start, scan + base + idx2);
    int32_t b = ReadElem(ctx.live, start, scan + base + ((idx2 + 1) % cyc));
    if (f.param & 2)                                                        // :expand
    {
        int32_t ea = Expand(a), eb = Expand(b);
        int32_t smp = ea + (((eb - ea) * frac) >> 8);
        return sclamp(smp);
    }
    // :interp (in_b) blends stepped (0) -> linear (255). No in_b = plain linear.
    int32_t smp;
    if (f.in_b >= 0)
    {
        int32_t in = (e.nodes[f.in_b].is_signal) ? u2v(sg(e, s, f.in_b)) : (int32_t)s.nodes[f.in_b].value;
        in = vclamp(in);
        smp = a + (((b - a) * frac * in) >> (8 + VBITS));
    }
    else smp = a + (((b - a) * frac) >> 8);
    return v2sig(smp);
}

// average: one-pole EMA. cutoff k from param_from or const param (0=shut, 255=open).
inline int32_t opAudioAverage(const Graph& e, ExprState& s, int idx)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    int32_t x = rd(s, f.in_a);
    int32_t cs = (f.param_from >= 0 && e.nodes[f.param_from].is_signal) ? sg(e, s, f.param_from) : 0;
    int32_t c = (f.param_from >= 0)
              ? ((e.nodes[f.param_from].is_signal) ? u2v(cs < 0 ? -cs : cs)
                                                       : (int32_t)s.nodes[f.param_from].value)
              : (int32_t)f.param;
    if (c > VMAX) c = VMAX;
    int32_t k = c << (16 - VBITS);                          // Q16
    int32_t xq = x << kSlewQ;
    st.level += onePoleStep(xq - st.level, (uint32_t)k << 16);
    return st.level >> kSlewQ;
}

// Wavefold primitives (after Chris Johnson's Utility-Pair). Period 8192, output +-2048.
static inline int32_t FoldTri(int32_t x)              // triangle fold
{
    x = ((x + 2048) % 8192 + 8192) % 8192;            // wrap to [0, 8192), positive
    return (x < 4096) ? (x - 2048) : ((8191 - x) - 2048);
}
static inline int32_t FoldInt(int32_t x)              // antiderivative of FoldTri
{
    x = ((x + 2048) % 8192 + 8192) % 8192;
    int32_t x2 = x * 2;
    return (x < 4096) ? (((x2 + 1) * (x2 - 8191)) >> 3)
                      : ((-((x2 - 8191) * (x2 - 16383))) >> 3);
}

// ADAA wavefold core (antiderivative anti-aliasing). drive 0 = clean, VMAX = heavily folded.
// out = (F1(x)-F1(x_prev))/(x-x_prev); falls back to midpoint sample when dx~0.
static inline int32_t AdaaFold(int32_t sig, int32_t drive, int32_t& lastx, int32_t& lastval)
{
    if (drive < 0) drive = 0; else if (drive > VMAX) drive = VMAX;
    int32_t x   = (sig * (256 + drive)) >> 8;         // drive 0 -> x1 (clean) .. VMAX -> ~x17
    int32_t val = FoldInt(x);
    int32_t dx  = x - lastx;
    int32_t ret = (dx > 1 || dx < -1) ? (val - lastval) / dx
                                      : FoldTri((x + lastx) >> 1); // midpoint fallback near dx==0
    lastx = x; lastval = val;
    return sclamp(ret);
}

// wavefold: in_a = signal; drive from param_from or const. State: aux0=lastx, level=lastval.
inline int32_t opAudioWavefold(const Graph& e, ExprState& s, int idx)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    int32_t sig = rd(s, f.in_a);                           // fold ANY stream, no domain gate
    int32_t drive;
    if (f.param_from >= 0)
    {
        if (e.nodes[f.param_from].is_signal) { int32_t a = sg(e, s, f.param_from); drive = u2v(a < 0 ? -a : a); }
        else                                       drive = (int32_t)s.nodes[f.param_from].value;
    }
    else drive = (int32_t)f.param;
    return AdaaFold(sig, drive, st.aux0, st.level);
}

// kick: pitched sine with pitch sweep + exp decay + drive saturation. 32-bit only, no 64-bit divide.
// in_a=note, in_b=decay, param_from=drive, branch_start/param=sweep, clock_from=trigger.
static constexpr int     kKickQ     = 12;
static constexpr int32_t kKickSweepK = 65366;        // pitch env decay ~8 ms (Q16)
static constexpr int32_t kSnarePitchK = 65468;       // snare pitch env decay ~20 ms (Q16)
static constexpr uint32_t kKickIncMax = 1700000000u; // cap ~19 kHz, below Nyquist
static constexpr int32_t  kKickLpK    = 50000;       // ~6 kHz LP coeff (Q16)
static constexpr int32_t  kKickHpK    = 400;         // ~47 Hz HP coeff (Q16)
// DrumDecayK: absolute decay (0..VMAX -> one-pole coeff), squared map for snappy range.
// Drum voices (opKick / opSnare / opHat): voice shape after Mutable Instruments
// Plaits (Emilie Gillet). Analytic kernels with a one-shot envelope and a noise/
// body split. Reimplemented from scratch for the 12-bit Loupe runtime, not a
// direct port.
static inline int32_t DrumDecayK(int32_t decay, int shift, int floor_tau)
{
    int32_t tau = floor_tau + ((decay * decay) >> shift);
    int32_t k = 65536 / tau; return k < 1 ? 1 : (k > 65535 ? 65535 : k);
}
inline int32_t opKick(const Graph& e, ExprState& s, int idx, const Context& ctx, int32_t spb, bool triggered)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    bool fire = (f.clock_from >= 0) ? RisingEdgeOf(e, s, f.clock_from, st.last_clock) : triggered;
    if (fire) { st.level = SMAX << kKickQ; st.aux0 = 1 << 15; st.phase = 0; } // amp peak, pitch env ~1.0, phase reset
    int32_t note  = (f.in_a >= 0) ? (int32_t)s.nodes[f.in_a].value : 24;   // ~C1 default
    int32_t decay = (f.in_b >= 0) ? vclamp((int32_t)s.nodes[f.in_b].value) : VMID;
    int32_t drive = (f.param_from >= 0) ? vclamp((int32_t)s.nodes[f.param_from].value) : 0;
    int32_t sweep = (f.branch_start >= 0) ? vclamp((int32_t)s.nodes[f.branch_start].value) : (int32_t)f.param;
    // Pitch sweep: inc = base + base*env*depth. aux0 (Q15) decays ~1.0->0 from the hit.
    uint32_t base = ctx.pitch_table ? ctx.pitch_table[note & 0x7F] : 2926328u;   // ~C1 fallback
    int32_t  pe   = st.aux0;
    uint32_t baseEnv = umulhi32(base, (uint32_t)pe << 16);
    uint32_t inc = base + (uint32_t)((int32_t)(baseEnv >> 7) * sweep);
    if (inc > kKickIncMax || inc < base) inc = kKickIncMax;
    st.aux0 = (pe * kKickSweepK) >> 16;
    st.phase += inc * (uint32_t)ctx.catch_up_steps;
    int32_t osc = interpSine(st.phase);
    // Drive: dry/wet blend toward hard-clipped copy (drive 0 = clean sine).
    int32_t g   = 256 + ((drive * drive) >> 13);                           // ~1x..~9x (Q8)
    int32_t hot = sclamp((osc * g) >> 8);
    int32_t shaped = osc + (((hot - osc) * drive) >> VBITS);
    // Amp env: absolute-time decay (tempo-independent). VCA at full precision; TPDF-dithered.
    int32_t k = DrumDecayK(decay, 10, 48);
    st.level -= (((st.level >> 9) * k) >> 7);
    if (st.level < 0) st.level = 0;
    int32_t out = sclamp(ditherShift(shaped * (st.level >> 5), 18));
    // Band-pass filter: LP (~6 kHz) removes sweep aliasing; HP (~47 Hz) removes DC/subsonic.
    st.aux1 += onePoleStep((out << kKickQ) - st.aux1, (uint32_t)kKickLpK << 16);
    int32_t hplp = (int32_t)st.pos;
    hplp += onePoleStep(st.aux1 - hplp, (uint32_t)kKickHpK << 16);
    st.pos = (uint32_t)hplp;
    return sclamp(ditherShift(st.aux1 - hplp, kKickQ));
}

// snare: two sine modes (fifth apart) + band-passed noise blended by snappy.
// in_a=note, in_b=decay, param_from=snappy, branch_start/param=tone, clock_from=trigger.
inline int32_t opSnare(const Graph& e, ExprState& s, int idx, const Context& ctx, int32_t spb, bool triggered)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    bool fire = (f.clock_from >= 0) ? RisingEdgeOf(e, s, f.clock_from, st.last_clock) : triggered;
    if (fire) { st.level = SMAX << kKickQ; st.wraps = 1 << 15; }             // amp env + pitch-drop env
    if (st.aux0 == 0) st.aux0 = (int32_t)RngSeed(idx);
    int32_t note   = (f.in_a >= 0) ? (int32_t)s.nodes[f.in_a].value : 45;    // ~A2 default
    int32_t decay  = (f.in_b >= 0) ? vclamp((int32_t)s.nodes[f.in_b].value) : VMID;
    int32_t snappy = (f.param_from >= 0) ? vclamp((int32_t)s.nodes[f.param_from].value) : VMID;
    int32_t tone   = (f.branch_start >= 0) ? vclamp((int32_t)s.nodes[f.branch_start].value) : (int32_t)f.param;  // stream or baked const
    // body: two sine modes a fifth apart (808 pair) with pitch-drop env (wraps = Q15).
    uint32_t inc1 = ctx.pitch_table ? ctx.pitch_table[note & 0x7F] : 11705314u;
    int32_t pe = (int32_t)st.wraps;
    inc1 += umulhi32(inc1, (uint32_t)pe << 16) * 4;                          // +up to ~3x at hit (~1.6 oct)
    st.wraps = (uint32_t)(((int32_t)pe * kSnarePitchK) >> 16);
    uint32_t inc2 = inc1 + (inc1 >> 1);
    st.phase += inc1 * (uint32_t)ctx.catch_up_steps;
    st.pos   += inc2 * (uint32_t)ctx.catch_up_steps;
    int32_t body = (interpSine(st.phase) + interpSine(st.pos)) >> 1;
    // body env; noise env = body env squared (faster decay).
    int32_t k = DrumDecayK(decay, 10, 48);
    st.level -= (((st.level >> 9) * k) >> 7); if (st.level < 0) st.level = 0;
    int32_t ampB = st.level >> kKickQ;
    int32_t ampN = (ampB * ampB) >> 11;                                      // squared = shorter
    // Band-pass noise: LP(noise) -> HP -> LP = band around tone.
    uint32_t rng = (uint32_t)st.aux0;
    int32_t noise = (int32_t)(XorShift32(rng) >> (32 - VBITS)) - VMID;
    st.aux0 = (int32_t)rng;
    int32_t kc = (tone < 1 ? 1 : tone) << (16 - VBITS);                     // Q16 band centre
    st.aux1 += onePoleStep((noise << kKickQ) - st.aux1, (uint32_t)kc << 16); // pole 1 LP
    int32_t hpn = noise - (st.aux1 >> kKickQ);
    st.aux2 += onePoleStep((hpn << kKickQ) - st.aux2, (uint32_t)kc << 16);   // pole 2 LP of HP
    int32_t hp = st.aux2 >> kKickQ;
    // VCAs + snappy crossfade (0=body, VMAX=noise).
    int32_t gB = ditherShift(body * (st.level >> 5), 18);                    // body VCA, TPDF-dithered
    int32_t gN = (hp   * ampN) >> 11;
    return sclamp(gB + (((gN - gB) * snappy) >> VBITS));
}

// hat: six inharmonic squares (three accumulators + pairwise sums) -> metallic noise -> HP.
// in_a=note, in_b=decay, param_from=tone (HP cutoff), clock_from=trigger.
inline int32_t opHat(const Graph& e, ExprState& s, int idx, const Context& ctx, int32_t spb, bool triggered)
{
    const Node& f = e.nodes[idx]; NodeState& st = s.nodes[idx];
    bool fire = (f.clock_from >= 0) ? RisingEdgeOf(e, s, f.clock_from, st.last_clock) : triggered;
    if (fire) st.level = SMAX << kKickQ;
    int32_t note  = (f.in_a >= 0) ? (int32_t)s.nodes[f.in_a].value : 81;     // ~A5 default
    int32_t decay = (f.in_b >= 0) ? vclamp((int32_t)s.nodes[f.in_b].value) : 1200;
    int32_t tone  = (f.param_from >= 0) ? vclamp((int32_t)s.nodes[f.param_from].value) : 2600;
    // three inharmonic rates *1, *~1.45, *~1.62 (32-bit only).
    uint32_t inc1 = ctx.pitch_table ? ctx.pitch_table[note & 0x7F] : 93642516u;
    uint32_t inc2 = inc1 + umulhi32(inc1, 1932735283u);                      // *~1.45
    uint32_t inc3 = inc1 + umulhi32(inc1, 2662881724u);                      // *~1.62
    st.phase += inc1 * (uint32_t)ctx.catch_up_steps;
    st.pos   += inc2 * (uint32_t)ctx.catch_up_steps;
    st.aux0   = (int32_t)((uint32_t)st.aux0 + inc3 * (uint32_t)ctx.catch_up_steps);
    uint32_t p1 = st.phase, p2 = st.pos, p3 = (uint32_t)st.aux0;
    // six squares: three phases + pairwise sums, top bit -> +-1, summed -> +-6.
    int32_t metal = ((p1 & 0x80000000u) ? 1 : -1) + ((p2 & 0x80000000u) ? 1 : -1)
                  + ((p3 & 0x80000000u) ? 1 : -1) + (((p1 + p2) & 0x80000000u) ? 1 : -1)
                  + (((p2 + p3) & 0x80000000u) ? 1 : -1) + (((p1 + p3) & 0x80000000u) ? 1 : -1);
    int32_t sig = metal * 340;                                               // +-6 -> ~+-2040
    // high-pass for sizzle (tone = HP cutoff).
    int32_t kc = (tone < 1 ? 1 : tone) << (16 - VBITS);
    st.aux1 += ((((sig << kKickQ) - st.aux1) >> 10) * kc) >> 6;
    int32_t hp = sig - (st.aux1 >> kKickQ);
    int32_t k = DrumDecayK(decay, 10, 24);
    st.level -= (((st.level >> 9) * k) >> 7); if (st.level < 0) st.level = 0;
    return sclamp(ditherShift(hp * (st.level >> 5), 18));                    // VCA, TPDF-dithered
}

// ---------------------------------------------------------------------------
// mul: array_idx 0=gain (sat), 1=wrap, 2=vca (signal×ctrl), 3=bipolar (attenuverter), 4=ring.
// ---------------------------------------------------------------------------
inline int32_t Mul(const Graph& e, ExprState& s, const Node& f)
{
    if (f.array_idx == 2)                                       // vca: signal x control (0..VMAX -> 0..1 gain)
    {
        int32_t a = rd(s, f.in_a);
        int32_t g = (f.param_from >= 0) ? rd(s, f.param_from) : (int32_t)f.param;
        return sclamp(ditherShift(a * v2u(g), 11));            // TPDF-dithered
    }
    if (f.array_idx == 4)                                       // ring: signal x signal, both bipolar (4-quadrant)
    {
        int32_t a = (f.in_a >= 0 && e.nodes[f.in_a].is_signal) ? s.nodes[f.in_a].value : v2sig(rd(s, f.in_a));
        int32_t b = (f.param_from >= 0)
                  ? (e.nodes[f.param_from].is_signal ? s.nodes[f.param_from].value : v2sig(s.nodes[f.param_from].value))
                  : v2sig(f.param);
        return sclamp(ditherShift(a * b, 11));                 // TPDF-dithered
    }
    if (f.array_idx == 3)                                       // :bipolar, attenuverter (gain centred at VMID)
    {
        int32_t av = (f.in_a >= 0 && e.nodes[f.in_a].is_signal) ? s.nodes[f.in_a].value
                                                                : v2sig(s.nodes[f.in_a].value);
        int32_t g  = ((f.param_from >= 0) ? s.nodes[f.param_from].value : (int32_t)f.param) - VMID;
        return sclamp((av * g) >> 11);
    }
    int32_t a = rd(s, f.in_a);
    int32_t n = (f.param_from >= 0) ? rd(s, f.param_from) : (int32_t)f.param;
    return (f.array_idx == 1) ? vwrap(a * n) : vclamp(a * n);
}

// ---------------------------------------------------------------------------
// Recompute: evaluate one node from the previous sample's committed inputs.
// Clock-gated generators self-gate on their clock_from form's wraps count.
// ---------------------------------------------------------------------------
inline int32_t LENS_AUDIO_HOT(Recompute)(const Graph& e, ExprState& s,
                                         const Context& ctx, int i)
{
    const Node& f = e.nodes[i];
    const int32_t a = rd(s, f.in_a);
    const int32_t b = rd(s, f.in_b);
    const int32_t spb = (ctx.spb > 0) ? ctx.spb : 12000;
    const bool    has_clock   = (f.clock_from >= 0);
    const int32_t clock_wraps = has_clock ? (int32_t)s.nodes[f.clock_from].wraps : (int32_t)s.nodes[i].clk_seen;
    switch (f.kind)
    {
        case NODE_ARRANGE: return opArrange(e, s, ctx, i, clockAdvanced(s.nodes[i], clock_wraps));
        case NODE_LOOKUP:  return opLookup(e, s, ctx, i, a);
        case NODE_SHIFT:   return opShift(e, s, ctx, i, a);
        case NODE_TAP:     return opTap(e, s, ctx, i);
        case NODE_NOISE:   return opNoise(s, i, (int32_t)f.param);
        case NODE_CRUSH:   return opCrush(e, s, i);
        case NODE_VCF:     return opVcf(e, s, i);

        // value ALU. add/sub wrap (:sat = array_idx 1 clamps); mul/div saturate.
        case NODE_TRANSPOSE: { int32_t n = (f.param_from >= 0) ? rd(s, f.param_from) : (int32_t)f.param; return vclamp(a + n); }
        case NODE_INVERT: return VMAX - a;
        case NODE_ADD:  { int32_t v = a + b; return (f.array_idx == 1) ? vclamp(v) : v; }
        case NODE_SUB:  { int32_t v = a - b; return (f.array_idx == 1) ? vclamp(v) : v; }
        case NODE_MUL:  return Mul(e, s, f);
        case NODE_DIV:  { int32_t n = (f.param_from >= 0) ? rd(s, f.param_from) : (int32_t)f.param; return (n > 0) ? a / n : 0; }
        case NODE_MOD:  { int32_t n = (f.param_from >= 0) ? rd(s, f.param_from) : (int32_t)f.param; return (n > 0) ? a % n : 0; }
        case NODE_SPREAD: { int32_t n = (f.param_from >= 0) ? rd(s, f.param_from) : (int32_t)f.param; if (n <= 0) return 0; int32_t v = (a * n) >> VBITS; return (v >= n) ? n - 1 : v; }
        case NODE_XOR:  return a ^ b;
        case NODE_AND:  return a & b;
        case NODE_OR:   return a | b;
        case NODE_MASK: return a & ((f.param_from >= 0) ? rd(s, f.param_from) : (int32_t)f.param);
        case NODE_BIT:  return ((a >> (f.param & 7)) & 1) ? VMAX : 0;
        case NODE_GT:   return (a >  b) ? VMAX : 0;
        case NODE_GTE:  return (a >= b) ? VMAX : 0;
        case NODE_LT:   return (a <  b) ? VMAX : 0;
        case NODE_LTE:  return (a <= b) ? VMAX : 0;
        case NODE_EQ:   return (a == b) ? VMAX : 0;
        case NODE_NE:   return (a != b) ? VMAX : 0;

        case NODE_COUNTER: return opCounter(s, i, f.param, clock_wraps);
        case NODE_EDGE:    return opEdge(s, i, a);
        case NODE_DIFF:    return opDiff(s, i, a);
        case NODE_TOGGLE:  return opToggle(s, i, a);
        case NODE_SCHMITT: return opSchmitt(s, i, a, b, (f.param_from >= 0) ? rd(s, f.param_from) : (int32_t)f.param);
        case NODE_HOLD:    return opHold(e, s, i, a, b);
        case NODE_SWITCH:  return opSwitch(e, s, i, a);

        // panel / jack leaves
        case NODE_KNOB:        return opKnob(f, ctx);
        case NODE_CV_IN:       return opCvIn(f, ctx);
        case NODE_PULSE_IN:    return (ctx.in && ctx.in->pulse_in[(f.param == 2) ? 1 : 0]) ? VMAX : 0;
        case NODE_ACTIVE_PAGE: return ctx.in ? ctx.in->active_page : 0;
        case NODE_SWITCH_POS:  return ctx.in ? ctx.in->switch_pos : 1;   // Z-switch: 0 down, 1 middle, 2 up
        case NODE_FROZEN: { int t = f.array_idx; return (t >= 0 && t < kMaxTapes && ctx.tapes[t].frozen) ? VMAX : 0; }
        case NODE_CONNECTED: return (ctx.in && ctx.in->connected[(uint8_t)f.param & 0x07]) ? VMAX : 0;
        case NODE_TURNS:  return has_clock ? vwrap((int32_t)s.nodes[f.clock_from].wraps) : 0;
        case NODE_CONST:  return f.param;

        // generative leaves
        case NODE_RANDOM:   return opRandom(e, s, i, clockAdvanced(s.nodes[i], clock_wraps));
        // chance: re-rolls each tick, holds between.
        case NODE_CHANCE:   { NodeState& st = s.nodes[i]; if (st.phase == 0) st.phase = RngSeed(i); if (clockAdvanced(st, clock_wraps)) { uint32_t r = XorShift32(st.phase); st.level = ((int32_t)(r >> (32 - VBITS)) < a) ? VMAX : 0; } return st.level; }
        case NODE_WALK:     return opWalk(e, s, i, clockAdvanced(s.nodes[i], clock_wraps));
        case NODE_GATE:     { int32_t thresh = (f.in_b >= 0) ? rd(s, f.in_b) : VMID; return (a > thresh) ? VMAX : 0; }

        // signal sources
        case NODE_SLEW:     return opAudioSlew(e, s, i, spb);
        case NODE_ENVELOPE: return opAudioEnvelope(e, s, i, spb, !has_clock && clockAdvanced(s.nodes[i], clock_wraps));
        case NODE_SHAPE:    return opAudioShape(e, s, i, ctx);
        case NODE_PHASOR:   return opAudioPhasor(e, s, i, ctx);
        case NODE_FOLLOW:   return opAudioFollow(e, s, ctx, i);
        case NODE_VCLOCK:   return opVClock(e, s, ctx, i);
        // tick: VMAX on the sample the clock wraps, else 0.
        case NODE_TICK:     return clockAdvanced(s.nodes[i], clock_wraps) ? VMAX : 0;
        case NODE_SNAP: {
            // snap: nearest note in 12-bit scale mask. Ties prefer lower note.
            int32_t m = (f.param_from >= 0) ? rd(s, f.param_from) : (int32_t)f.param;
            if ((m & 0xFFF) == 0) return a;
            int32_t n = a < 0 ? 0 : (a > 127 ? 127 : a);
            for (int32_t d = 0; d < 12; ++d)
            {
                int32_t lo = n - d, hi = n + d;
                if (lo >= 0   && (m >> (lo % 12)) & 1) return lo;
                if (hi <= 127 && (m >> (hi % 12)) & 1) return hi;
            }
            return n;
        }
        case NODE_WAVE:     return opAudioWave(e, s, i, ctx);
        case NODE_AVERAGE:  return opAudioAverage(e, s, i);
        case NODE_WAVEFOLD: return opAudioWavefold(e, s, i);
        case NODE_KICK:     return opKick(e, s, i, ctx, spb, !has_clock && clockAdvanced(s.nodes[i], clock_wraps));
        case NODE_SNARE:    return opSnare(e, s, i, ctx, spb, !has_clock && clockAdvanced(s.nodes[i], clock_wraps));
        case NODE_HAT:      return opHat(e, s, i, ctx, spb, !has_clock && clockAdvanced(s.nodes[i], clock_wraps));
        case NODE_AUDIO_IN: return sclamp(ctx.audio_in[(f.param == 2) ? 1 : 0]);

        // terminals: pass-through (jack interprets the value)
        case NODE_V_OCT:    return a;
        case NODE_CV:       return a;
        default: return 0;
    }
}

// ===========================================================================
// Schedule: one flat interval-sorted list over the whole card.
// Must-run prefix (interval<=1) recomputes every sample; control suffix round-robins.
// ===========================================================================
struct SchedSlot
{
    ExprState*   s;         // the runtime state (the graph's bound slice)
    const Graph* e;         // the graph
    int16_t      node;      // index into e->nodes[]
    int8_t       core;      // 0 or 1; split is semantics-free (all reads see previous commit)
    int32_t      interval;    // sort key (= e->nodes[node].interval); smaller = higher priority
};

// Core 1 bias: first kCore1Bias must-run slots go to Core 1, rest alternate.
static constexpr int kCore1Bias = 6;

// Control quantum: whole suffix sweeps at least once per kCtrlQuantum samples (~1 ms).
static constexpr int kCtrlQuantum = 48;

struct Schedule
{
    SchedSlot slot[kNodePool];
    int       count;
    int       must;        // interval<=1 prefix length (audio + edge/diff: run every sample)
    int       cursor;      // round-robin position in the control suffix [must, count)
    int       stride;      // control slots per sample = ceil(suffix / kCtrlQuantum)
    // Per-core dense index lists over the must-run prefix (rebuilt by SchedSort / BalancePartition).
    struct CorePartition { int16_t slots[kNodePool]; int count; } cores[2];
};

inline void RebuildCorePartition(Schedule& sch)
{
    sch.cores[0].count = sch.cores[1].count = 0;
    for (int k = 0; k < sch.must; ++k)
    {
        const int c = sch.slot[k].core ? 1 : 0;
        sch.cores[c].slots[sch.cores[c].count++] = (int16_t)k;
    }
}

// Append every node of the graph to the schedule.
inline void SchedAdd(Schedule& sch, ExprState* st, const Graph* e)
{
    if (!e || !st) return;
    for (int i = 0; i < e->length && sch.count < kNodePool; ++i)
    {
        SchedSlot& sl = sch.slot[sch.count++];
        sl.s = st; sl.e = e; sl.node = (int16_t)i;
        sl.interval = e->nodes[i].interval;
    }
}

// Sort by interval ascending, once at patch apply. Insertion sort: small N, off the hot path.
inline void SchedSort(Schedule& sch)
{
    for (int i = 1; i < sch.count; ++i)
    {
        SchedSlot key = sch.slot[i];
        int j = i - 1;
        while (j >= 0 && sch.slot[j].interval > key.interval) { sch.slot[j + 1] = sch.slot[j]; --j; }
        sch.slot[j + 1] = key;
    }
    sch.must = 0;
    while (sch.must < sch.count && sch.slot[sch.must].interval <= 1) ++sch.must;
    sch.cursor = sch.must;
    sch.stride = (sch.count - sch.must + kCtrlQuantum - 1) / kCtrlQuantum;  // 0 when no control suffix

    // Partition must-run across cores (hardware replaces with BalancePartition at apply).
    for (int k = 0; k < sch.count; ++k)
        sch.slot[k].core = (k < sch.must) ? ((k < kCore1Bias) ? 1 : (int8_t)((k - kCore1Bias) & 1)) : 0;
    RebuildCorePartition(sch);
}

// Prime consts so downstream nodes don't see uninitialised 0 on the first sample.
inline void SchedPrime(Schedule& sch)
{
    for (int k = 0; k < sch.count; ++k)
    {
        const Node& f = sch.slot[k].e->nodes[sch.slot[k].node];
        if (f.kind == NODE_CONST)
        {
            NodeState& st = sch.slot[k].s->nodes[sch.slot[k].node];
            st.value = st.next = f.param;
        }
    }
}

// Recompute one slot into its `next` shadow. Reads see the previous commit (order irrelevant).
inline void LENS_AUDIO_HOT(RunSlot)(const SchedSlot& sl, const Context& ctx)
{
    const Node& f = sl.e->nodes[sl.node];
    int32_t v = Recompute(*sl.e, *sl.s, ctx, sl.node);
    sl.s->nodes[sl.node].next = f.is_signal ? sclamp(v) : vwrap(v);
}

// Commit one slot's shadow. Any stream can clock (value crosses VMID -> wraps++).
// Phasor ramps peak at 2047 (<VMID) so they never trigger here; their ops own wraps.
inline void LENS_AUDIO_HOT(CommitSlot)(const SchedSlot& sl)
{
    NodeState& st = sl.s->nodes[sl.node];
    if (st.value <= VMID && st.next > VMID) st.wraps++;
    st.value = st.next;
}

// ===========================================================================
// Dual-core per-sample primitives (Core 0 + Core 1 doorbell path).
// ===========================================================================

// Recompute one core's must-run share.
inline void LENS_AUDIO_HOT(RunMust)(Schedule& sch, const Context& ctx, int core)
{
    const int16_t* L = sch.cores[core & 1].slots;
    const int      m = sch.cores[core & 1].count;
    for (int i = 0; i < m; ++i) RunSlot(sch.slot[L[i]], ctx);
}

// Commit one core's must-run share. CommitSlot is idempotent (double-commit is safe).
inline void LENS_AUDIO_HOT(CommitMust)(Schedule& sch, int core)
{
    const int16_t* L = sch.cores[core & 1].slots;
    const int      m = sch.cores[core & 1].count;
    for (int i = 0; i < m; ++i) CommitSlot(sch.slot[L[i]]);
}

// Run `budget` control slots round-robin. Returns slice for CommitCtrl.
struct CtrlSlice { int from; int run; };
inline CtrlSlice LENS_AUDIO_HOT(RunCtrl)(Schedule& sch, const Context& ctx, int budget)
{
    const int n = sch.count - sch.must;
    CtrlSlice cs { sch.cursor, 0 };
    if (n <= 0 || budget <= 0) return cs;
    cs.run = (budget < n) ? budget : n;
    int k = cs.from;
    for (int i = 0; i < cs.run; ++i)
    {
        RunSlot(sch.slot[k], ctx);
        if (++k >= sch.count) k = sch.must;
    }
    sch.cursor = k;
    return cs;
}

inline void LENS_AUDIO_HOT(CommitCtrl)(Schedule& sch, CtrlSlice cs)
{
    int k = cs.from;
    for (int i = 0; i < cs.run; ++i)
    {
        CommitSlot(sch.slot[k]);
        if (++k >= sch.count) k = sch.must;
    }
}

// ===========================================================================
// Single-core sim entrypoint (sim + settle loops; not the hardware audio path).
// ===========================================================================

// One full sample on one core. Only ran slots commit (held slots have next==value).
inline void LENS_AUDIO_HOT(RunSchedule)(Schedule& sch, const Context& ctx, int budget)
{
    RunMust(sch, ctx, 0);
    RunMust(sch, ctx, 1);
    CtrlSlice cs = RunCtrl(sch, ctx, budget);
    CommitMust(sch, 0);
    CommitMust(sch, 1);
    CommitCtrl(sch, cs);
}

}  // namespace loupe
