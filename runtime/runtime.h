#pragma once
#include "slot.h"
#include "snapshot_format.h" /* LENS_JACK_* constants */
#include <stdint.h>
#include <stddef.h>

/*
 * Buffer: shared ring-buffer, cells 12-bit packed (2 per 3 bytes).
 * Each recordhead tracks its own position.
 * Byte storage: (length * 3 + 1) >> 1 bytes.
 */
struct Buffer {
    uint8_t*  bytes;
    uint32_t  length;   /* cells; up to the full audio pool (~87381 = 1.82 s) */
};

/* ---- Static pool sizes ---- */
#ifndef LENS_PERF_PROBE
#define LENS_PERF_PROBE 0
#endif
/* 128 KB torus (release) or 64 KB with perf profiler compiled in. */
#if LENS_PERF_PROBE
#define LENS_AUDIO_BUFFER_BYTES (64 * 1024)
#else
#define LENS_AUDIO_BUFFER_BYTES (128 * 1024)
#endif
#define LENS_CONTROL_BUFFER_BYTES (1024)
#define LENS_MAX_SLOTS            256
#define LENS_NODESTATE_BYTES      (4 * 1024)  /* op_wavetable state is ~1 KB/instance -> a
                                                 few voices fit; bump to 8K for more */
#define LENS_MAX_BUFFERS          16
#define LENS_MAX_TERMINALS        16
#define LENS_CONST_POOL_WORDS     64
#define LENS_MAX_KFNS             128

/*
 * Hardware input/output snapshots (one per sample).
 *
 * SPEC: hw input indices for leaf kernel param0:
 *   0=audio-in-1, 1=audio-in-2,
 *   2=pulse-in-1, 3=pulse-in-2,
 *   4=cv-in-1,    5=cv-in-2,
 *   6=knob-main,  7=knob-x, 8=knob-y,
 *   9=switch-pos
 */
struct HardwareInputs {
    int32_t audio_in_1, audio_in_2;
    int32_t pulse_in_1, pulse_in_2;
    int32_t cv_in_1,    cv_in_2;
    int32_t knob_main,  knob_x, knob_y;
    int32_t switch_pos;
    /* One bit per input jack (by hw-scratch index: 0/1 audio, 2/3 pulse, 4/5 cv);
       set when a cable is physically patched. Drives `connected` (and `normal`, its sugar),
       which needs real jack detection (a clock pulse reads 0 between edges, so a
       value test cannot tell a patched clock from an idle one). */
    uint16_t connected;
};

struct HardwareOutputs {
    int32_t audio_out_1, audio_out_2;
    int32_t cv_out_1,    cv_out_2;
    int32_t pulse_out_1, pulse_out_2;
    int32_t led_0, led_1, led_2, led_3, led_4, led_5;
    /* When set, cv_out_N carries a MIDI note (0..127) for the card's calibrated
       1V/oct DAC (CVOutMIDINote), not a raw value. Set by runtime_drive_terminals
       when the cv-out's source kernel is op_v_oct. */
    uint8_t cv_out_1_is_pitch, cv_out_2_is_pitch;
};

/* Terminal: maps a jack output to the slot (walk-order index) whose value drives it. */
struct RuntimeTerminal {
    uint8_t  jack_id;
    uint8_t  mode;          /* 0 = raw; 1 = v/oct pitch (cv-out): value is a MIDI note */
    uint16_t slot_walk_idx;
};

/*
 * LensRuntime: flat state for one running patch.
 * Points into static pools; reset by snapshot_apply on each load.
 *
 * Pool layout: for each slot i (walk order), 8 + state_size bytes.
 *   pool[offset + 0..3] = out (the slot's value; slot.out points here)
 *   pool[offset + 4..7] = second output field (phasor/follow tick, recordhead
 *                         head_pos), read by consumers via a +4 ref
 *   pool[offset + 8..]  = kernel-specific extra state
 */
struct LensRuntime {
    struct Slot*            slots;
    uint16_t                slot_count;

    uint8_t*                state_pool;
    uint32_t                state_pool_size;

    int32_t*                const_pool;  /* inline constants resolved from in_refs */
    uint16_t                const_count;

    struct Buffer*          buffers;
    uint8_t                 buffer_count;

    struct RuntimeTerminal* terminals;
    uint8_t                 terminal_count;

    /* Set by snapshot_apply if any slot is a recordhead, so recordhead_sweep can
     * skip its whole-slot scan on the common (no-delay) patch. */
    uint8_t                 has_recordhead;

    /* Walk index of the master clock slot (0xFFFF = none). Core 0 edge-detects this
     * slot's output to align beat/bar-quantised live swaps to the running tempo. */
    uint16_t                master_slot_idx;

    /*
     * sample_counter: incremented by Core 0 at the end of each sample walk.
     * Core 1 spin-polls this; must be volatile so the compiler does not
     * cache the value across spin-poll iterations.
     */
    volatile uint32_t       sample_counter;

    /* Each core's slots in walk order. Built by snapshot_apply; used by the
     * dual-core walk functions. */
    struct Slot**           core0_slots; uint16_t core0_count;
    struct Slot**           core1_slots; uint16_t core1_count;

    /*
     * core1_done: set by Core 1 to the sequence number after each
     * runtime_walk_core1. Core 0 never waits on it (the audio path is
     * non-blocking); only the perf/status journal reads it.
     */
    volatile uint32_t       core1_done;

    /*
     * Cross-core shadow publish list. Entry i copies *xcore_src[i] into
     * lens_shadow_pool[i] once per sample at the boundary. A cross-core
     * consumer reads the shadow (last sample's value), giving a deterministic
     * one-sample lag instead of an order-dependent race. Built by snapshot_apply.
     */
    int32_t*                xcore_src[LENS_MAX_SLOTS];
    uint8_t                 xcore_core[LENS_MAX_SLOTS];  /* producer core per shadow: each core publishes only its own */
    uint16_t                xcore_count;

#if LENS_PERF_PROBE
    /* Per-slot cycle accumulators. Cleared at apply time; updated around each
     * kernel call (step_slot).
     * slot_cycle_total[i]: running sum of DWT cycles for slot i.
     * slot_cycle_max[i]:   peak single-call cycle count for slot i.
     * slot_call_count[i]:  number of times slot i has been invoked. */
    uint32_t                slot_cycle_total[LENS_MAX_SLOTS];
    uint32_t                slot_cycle_max[LENS_MAX_SLOTS];
    uint32_t                slot_call_count[LENS_MAX_SLOTS];
#endif
};

/* Backing arenas (defined in snapshot_apply.c). */
extern uint8_t              lens_audio_pool[LENS_AUDIO_BUFFER_BYTES];
extern uint8_t              lens_control_pool[LENS_CONTROL_BUFFER_BYTES];
extern uint8_t              lens_nodestate_pool[LENS_NODESTATE_BYTES];
/* Live used bytes of the node-state / control pools (settings-save overlay). */
size_t lens_nodestate_used(void);
size_t lens_control_used(void);
extern struct Slot          lens_slot_pool[LENS_MAX_SLOTS];
extern struct Buffer        lens_buffer_pool[LENS_MAX_BUFFERS];
extern struct RuntimeTerminal lens_terminal_pool[LENS_MAX_TERMINALS];
extern int32_t              lens_const_pool[LENS_CONST_POOL_WORDS];
extern int32_t              lens_shadow_pool[LENS_MAX_SLOTS];

/* Each core's slots in walk order (defined in snapshot_apply.c): every slot
 * with slot_core==0 (resp. 1). Used by runtime_walk_core0/1. */
extern struct Slot*         lens_core0_flat_ptrs[LENS_MAX_SLOTS];
extern struct Slot*         lens_core1_flat_ptrs[LENS_MAX_SLOTS];

/* --- API ------------------------------------------------------------------ */

/* Returns pointer into hw_scratch for the given jack index (0..9). */
int32_t* runtime_hw_jack_ptr(uint32_t jack_idx);


/* Refresh hw_scratch from a new sample of inputs. Called at the top of
 * each per-sample tick so leaf kernels (which read through hw_scratch
 * pointers baked at apply time) see this sample's values. */
void runtime_update_hw_scratch(const struct HardwareInputs* hw);

/* Parse snapshot bytes, wire a static LensRuntime. Returns 0 on success. */
int snapshot_apply(struct LensRuntime** out_rt, const uint8_t* bytes, size_t len);

/* Advance one sample on a single thread: walk every slot in order, then publish
 * cross-core shadows. Models any snapshot (single- or dual-core) for the host
 * sim; the hardware audio path uses runtime_walk_core0/1 instead. */
void runtime_step(struct LensRuntime* rt,
                  const struct HardwareInputs* hw,
                  struct HardwareOutputs* hw_out);

/* Reference walk: minimal model, every slot every sample in walk order, shadows
 * published at the boundary. The oracle the optimized walk is diffed against. */
void runtime_step_reference(struct LensRuntime* rt,
                            const struct HardwareInputs* hw,
                            struct HardwareOutputs* hw_out);

/*
 * Dual-core walk primitives: the orchestrator (main.cpp) calls these on each
 * core. Each walks its core's flat slot list; seq is unused (kept for the call
 * signature). Each core then sweeps its own recordheads and publishes its own
 * shadows; Core 0 drives terminals and never waits on Core 1 (a late Core 1 just
 * holds last sample's shadow). Each slot writes its output directly during the
 * walk, so no separate commit pass is needed.
 */
void runtime_walk_core0(struct LensRuntime* rt, uint32_t seq);
void runtime_walk_core1(struct LensRuntime* rt, uint32_t seq);

/* End-of-tick sweep: apply any pending recordhead writes. Must run after
 * both cores' walks complete and before runtime_drive_terminals so the
 * driven values reflect the freshest committed tape state. */
void recordhead_sweep(struct LensRuntime* rt);

/* Per-core sweep/publish: each core commits its own recordheads and publishes
 * only the shadows it produces, so the two cores never touch each other's state
 * and Core 0 need not wait for Core 1 (the non-blocking dual path). */
void recordhead_sweep_core0(struct LensRuntime* rt);
void recordhead_sweep_core1(struct LensRuntime* rt);
void runtime_publish_shadows_core0(struct LensRuntime* rt);
void runtime_publish_shadows_core1(struct LensRuntime* rt);

/* Copy each cross-core producer's value into its shadow. Run at the sample
 * boundary AFTER both cores' walks and recordhead_sweep, BEFORE drive_terminals. */
void runtime_publish_shadows(struct LensRuntime* rt);

/* Write terminal slot values to hw_out (called from runtime_step). */
void runtime_drive_terminals(struct LensRuntime* rt, struct HardwareOutputs* hw_out);

/* No-op: pools are static; no allocation to free. */
void runtime_destroy(struct LensRuntime* rt);

/* Find kernel by name; returns KID_UNKNOWN if not found. */
uint8_t runtime_find_kernel(const char* name);

/* Returns non-zero if kid is a hardware-leaf kernel (needs hw-jack routing). */
int runtime_is_hw_leaf(uint8_t kid);

/* Returns non-zero if kid is a MIDI-leaf kernel (needs midi-scratch routing). */
int runtime_is_midi_leaf(uint8_t kid);

/* Wire s->fn from KFN[s->kernel_id]; called once per slot at apply time. */
void runtime_slot_wire_fn(struct Slot* s);

/* Return the NodeState byte size for the given kernel id. */
uint32_t runtime_kernel_state_bytes(uint8_t kid);

/* DX7 log-domain 4-rate/4-level envelope state (shared between op_dxeg and op_dx). */
struct DxEgState {
    int32_t value;
    int32_t level_, targetlevel_, inc_, ix_, rising_, down_, last_gate, inited;
    int32_t rate_scaling_;   /* per-note qrate offset (msfa ScaleRate); 0 = none */
    int32_t staticcount_;    /* samples left to hold a flat segment (msfa ACCURATE_ENVELOPE) */
};

/* Faithful port of msfa PitchEnv (pitchenv.cc): the DX7 pitch envelope, swept in
   the logfreq (Q24) domain and added to ratio operators' frequency. The kick's
   "thud" is this envelope sweeping the carriers down at note onset. */
struct PitchEnvState {
    int32_t rates_[4], levels_[4];   /* raw DX7 PEG rates/levels (0..99) */
    int32_t level_, targetlevel_, inc_, ix_, rising_, down_;
    int32_t last_gate, inited;
};

/* op_dx voice state: 6 oscillators, each with phase, feedback history, and DX EG. */
struct FmState {
    int32_t  value;
    uint32_t phase[6];
    int32_t  y0[6], y1[6];
    struct DxEgState eg[6];
    int32_t  rate_scaling[6];  /* per-op DX7 rate-scaling delta (ScaleRate), note-on computed */
    int32_t  ks_mult[6];       /* per-op keyboard-scaling gain multiplier (Q16) */
    int32_t  ks_pitch;         /* note ks_mult was computed for (-1 = uncomputed) */
    /* flash-bank cache: parsed on (bank,preset) change. cells_valid=0 until first parse. */
    int32_t  cells[56];
    int32_t  cached_bank;
    int32_t  cached_preset;
    int32_t  cells_valid;
    /* msfa-faithful frequency derivation (FLASH mode): per-op logfreq base (Q24,
       note-independent: coarse+fine for ratio ops, the full fixed logfreq for
       fixed ops) + a ratio mask (bit op set => add the played note + pitch env). */
    int32_t  logfreq[6];
    int32_t  op_ratio;         /* bit i set: op i is a ratio op (note + pitch env apply) */
    struct PitchEnvState peg;  /* global pitch envelope (DX7 bytes 102..109) */
};

/* op_dx frequency-cell encoding. A ratio operator's cell holds (semitone offset + 64),
   always well under FM_FIXED_FLAG. A fixed-frequency operator's cell holds its absolute
   note in 1/12-semitone units + FM_FIXED_BIAS (sub-semitone, so FM sidebands beat at the
   right rate); the kernel detects fixed ops by cell >= FM_FIXED_FLAG. Note -36..123 in
   twelfths = -432..1476, + bias 2480 = 2048..3956 (fits 12 bits, all >= the flag). */
#define FM_FIXED_FLAG 2048
#define FM_FIXED_BIAS 2480

/* Parse one DX7 voice (128 raw bytes) into 56 op_dx cells. Mirrors dx7import.voiceCells. */
void dx7_parse_voice(const uint8_t* v128, int32_t cells[56]);

/* Fused DX7 voice kernel from a flash bank (param0=bank):
   in0=decay, in1=pitch, in2=gate, in3=preset, in4=tone. */
void op_dx(struct Slot* s);
