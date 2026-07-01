/*
 * Lens hardware host — ComputerCard subclass + boot + dual-core init.
 *
 * ComputerCard by Chris Johnson (see ComputerCard.h).
 *
 * Core 0: audio interrupt via ComputerCard::ProcessSample() -> runtime_walk_core0().
 * Core 1: TinyUSB device stack + sysex receive parser + runtime_walk_core1().
 *
 * Dual-core model (non-blocking):
 *   Core 0 (audio ISR) rings Core 1 via the SIO FIFO doorbell each sample, walks
 *   its own slots, sweeps its own recordheads, publishes its own shadows, drives
 *   the output jacks, and increments sample_counter. It never waits on Core 1.
 *   Core 1's doorbell IRQ walks its slots, sweeps and publishes its own, and sets
 *   core1_done. A late Core 1 just holds last sample's shadow (one extra sample of
 *   cross-core lag, never a stall). Cross-core reads see the previous sample's
 *   shadow, so a forward reference is free one-sample feedback.
 */

#include "ComputerCard.h"
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "hardware/clocks.h"
#include "hardware/vreg.h"
#include "hardware/sync.h"
#include "hardware/flash.h"
#include "hardware/irq.h"
#include "hardware/structs/sio.h"
#include "hardware/watchdog.h"
#include "bsp/board_api.h"  /* board_init */
#include "tusb.h"
#include "sysex.h"
#include "midi.h"
#include "usb_midi_host.h"

#include "hardware/structs/mpu.h"

extern "C" {
#include "runtime.h"
#include "factory_snapshot.h"
}

/* ---- Flash save-slot layout ----
 *
 * Pico has 2 MB flash (PICO_FLASH_SIZE_BYTES = 2097152).
 * Reserve the last two 4 KB sectors (8 KB) for the saved snapshot + live state.
 * Offset is XIP_BASE-relative for reading; flash_range_* use byte offsets
 * from flash origin (no XIP_BASE added).
 *
 * Layout inside the slot:
 *   [0..3]    magic "LENS"  (4 bytes)
 *   [4..7]    build hash u32 LE (rejects a snapshot saved by a different build)
 *   [8..9]    snapshot length u16 LE
 *   [10..11]  node-state pool length u16 LE  (live state, 0 = none)
 *   [12..13]  control pool length u16 LE      (live tape/register state, 0 = none)
 *   [14..]    snapshot bytes, then node-state pool bytes, then control pool bytes
 *   [N..N+3]  CRC32 over bytes [0..N)
 *
 * The pools are saved as raw bytes. Restore copies them back over the live pools
 * after snapshot_apply: the same snapshot re-bumps to the same per-slot offsets, so
 * the bytes line up with no per-kernel interpretation. The build-hash guard ensures
 * struct layouts match. Audio-pool buffers (delay lines, recorded audio) are NOT
 * saved: only node state and the small control pool (registers, short tapes). If the
 * snapshot plus pools would overflow the slot, the save falls back to patch-only
 * (nd_len = ct_len = 0). The 8 KB staging buffer (g_pending) caps a write at 8 KB.
 */
#define LENS_SAVE_MAGIC    "LENS"
#define LENS_SAVE_MAGIC_LEN 4
#define LENS_SAVE_HDR_LEN  (LENS_SAVE_MAGIC_LEN + 4u + 2u + 2u + 2u) /* magic+hash+snap_len+nd_len+ct_len */
#define LENS_SAVE_SLOT_SIZE (8u * 1024u)               /* two sectors */
#define LENS_SAVE_SLOT_OFF  (PICO_FLASH_SIZE_BYTES - LENS_SAVE_SLOT_SIZE)
#define LENS_SAVE_SLOT_XIP  (XIP_BASE + LENS_SAVE_SLOT_OFF)

/* Simple CRC32 (ISO 3309 / Ethernet polynomial). */
static uint32_t crc32_update(uint32_t crc, const uint8_t* data, size_t len) {
    crc = ~crc;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int k = 0; k < 8; k++)
            crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1u));
    }
    return ~crc;
}

static uint32_t save_crc32(const uint8_t* data, size_t len) {
    return crc32_update(0, data, len);
}

/* ---- DWT cycle counter ---- */
/* RP2040 Cortex-M0+ has no DWT.CYCCNT; SysTick is used instead:
 * a free-running 24-bit DOWN counter at sysclk. Read with `cvr`. Per-sample
 * deltas are ~5k cycles at 250 MHz, well inside the 16M wrap window.
 * SysTick counts DOWN: elapsed = (start - end) & 0xFFFFFF. */
#define M0P_SYSTICK_CSR (*((volatile uint32_t *)0xE000E010))
#define M0P_SYSTICK_RVR (*((volatile uint32_t *)0xE000E014))
#define M0P_SYSTICK_CVR (*((volatile uint32_t *)0xE000E018))

static inline void dwt_enable(void) {
    M0P_SYSTICK_RVR = 0x00FFFFFFu;      /* 24-bit max */
    M0P_SYSTICK_CVR = 0;                /* writing clears */
    M0P_SYSTICK_CSR = (1u << 2) | 1u;   /* CLKSOURCE=core, ENABLE */
}

static inline uint32_t dwt_read(void) { return M0P_SYSTICK_CVR; }

/* ---- Perf ring (last 1024 samples) ---- */
/* LENS_PERF_PROBE default is in runtime.h; CMake forwards the build flag. */
#if LENS_PERF_PROBE
/* Three cycle sections per sample: walk (Core 0 slot walk), io (hw read + drive),
   total (full ProcessSample). All in raw DWT cycles. */
struct PerfRingEntry {
    uint16_t total;  /* full ProcessSample cycles (saturates at 65535) */
    uint16_t walk;   /* Core 0 walk cycles */
    uint16_t io;     /* hw_in gather + driveJacks cycles */
};
static struct PerfRingEntry __attribute__((section(".data"))) perf_ring[1024];
static uint32_t             __attribute__((section(".data"))) perf_head = 0;
/* SPEC: exposed for sysex PERF_DUMP handler (Core 1 reads, Core 0 writes). */
volatile struct PerfRingEntry* const lens_perf_ring    = perf_ring;
volatile uint32_t*             const lens_perf_head_p  = &perf_head;
const    uint32_t                    lens_perf_ring_len = 1024;
#endif

/* ---- UX state ---- */

/* Boot dance: L-shaped LED sweep for the first ~1.5 s. */
static const uint32_t kBootDanceSamples  = 72000u;
/* Save-arm: hold Z-switch down for ~5 s to arm a save. */
static const uint32_t kSaveArmHoldSamples = 240000u;

/* Counts samples elapsed since ProcessSample first ran. */
static uint32_t g_boot_sample    = 0u;
/* Counts consecutive samples the Z-switch has been held DOWN (pos 0). */
static uint32_t g_save_arm_count = 0u;
/* Set true when save-arm completes or CMD_SAVE_STATE received. */
static volatile bool g_save_requested     = false;
/* Set true when CMD_FACTORY_RESET received. */
static volatile bool g_factory_reset_requested = false;

/*
 * Cache of the last applied snapshot bytes.
 * Updated on every successful snapshot_apply (factory boot + sysex WRITE).
 * Written by Core 0 only; read by Core 0 only during flash-save sequence.
 *
 * 4 KB cap: observed patches top out at ~2 KB; SOURCE_CAP (8 KB) is a wire
 * decode budget, not a patch-size budget. Saves > 4 KB get silently dropped.
 */
#define LENS_SNAPSHOT_CACHE 4096u
static uint8_t  g_last_snapshot[LENS_SNAPSHOT_CACHE];
static uint16_t g_last_snapshot_len = 0;

/*
 * Active runtime pointer. Written by Core 0 only, at apply time at the top of
 * ProcessSample (before the ring). Core 1's audio IRQ reads it after the ring;
 * Core 1's USB foreground never touches it. Volatile prevents caching.
 */
static struct LensRuntime* volatile g_rt = nullptr;


/* ---- Diagnostics ----
 * Updated on every snapshot_apply attempt (factory boot + each CMD_WRITE_STATE).
 * Read by CMD_DIAG to give the host an authoritative picture without guessing
 * from audio output.
 */
#ifndef LENS_BUILD_HASH
#define LENS_BUILD_HASH 0u
#endif
static const  uint32_t g_build_hash         = (uint32_t)(LENS_BUILD_HASH);
static volatile int32_t  g_last_apply_rc    = 0;   /* return code of last snapshot_apply */
static volatile uint32_t g_apply_count      = 0;   /* successful applies since boot */
static volatile uint32_t g_apply_attempts   = 0;   /* attempts (success + fail) */
static volatile uint32_t g_snapshot_crc     = 0;   /* CRC32 trailer of current live snapshot */
static volatile uint32_t g_last_apply_sample = 0;  /* sample_counter when last apply landed */

static inline uint32_t snapshot_trailer_crc(const uint8_t* bytes, size_t len) {
    if (len < 4) return 0;
    size_t o = len - 4;
    return (uint32_t)bytes[o] | ((uint32_t)bytes[o+1] << 8)
         | ((uint32_t)bytes[o+2] << 16) | ((uint32_t)bytes[o+3] << 24);
}

/*
 * Tempo blink on led-5 is provided by the prelude as a default cable
 * (`(<- led-5 (envelope :trig (tick) :decay 2))`) so it tracks the user's
 * master clock. No hardcoded runtime override needed.
 */

/* ---- Flash request triggers (callable from Core 1 via sysex handler) ---- */
extern "C" void lens_request_save(void) {
    g_save_requested = true;
}
extern "C" void lens_request_factory_reset(void) {
    g_factory_reset_requested = true;
}

/* USB role: 1 = host, 0 = device. Set on Core 0 before Core 1 launches; Core 1
 * reads it once at startup to select the USB init path. */
volatile uint8_t g_usb_host_mode = 0;

/* Live-swap timing, set over sysex (CMD_SWAP_MODE). Written by Core 1, read by
 * Core 0. ZERO = next near-zero audio sample (default, click-free). BEAT / BAR =
 * align the swap to the running patch's master clock (a bar is 4 beats). */
enum { SWAP_AT_ZERO = 0, SWAP_AT_BEAT = 1, SWAP_AT_BAR = 2 };
volatile uint8_t g_swap_mode = SWAP_AT_ZERO;

/*
 * Perform flash save: erase slot, write magic+len+snapshot+crc32, reboot.
 * Must be called with Core 1 reset and interrupts disabled.
 */
static void do_flash_save(void) {
    if (g_last_snapshot_len == 0) return; /* nothing to save */

    const size_t HDR_LEN  = LENS_SAVE_HDR_LEN;
    const size_t snap_len = g_last_snapshot_len;
    /* Live state to overlay on restore: the node-state pool (op state, incl. pickup
       takeover values) and the small control pool (registers / short tapes). */
    size_t nd_len = lens_nodestate_used();
    size_t ct_len = lens_control_used();
    if (nd_len > LENS_NODESTATE_BYTES)      nd_len = LENS_NODESTATE_BYTES;
    if (ct_len > LENS_CONTROL_BUFFER_BYTES) ct_len = LENS_CONTROL_BUFFER_BYTES;

    /* If snapshot + live state overflow the slot or the 8 KB staging buffer, fall back
       to a patch-only save (still useful: the graph survives, settings reset). */
    if (HDR_LEN + snap_len + nd_len + ct_len + 4u > LENS_SAVE_SLOT_SIZE) {
        nd_len = 0;
        ct_len = 0;
    }
    const size_t payload_len = HDR_LEN + snap_len + nd_len + ct_len;
    const size_t total_len   = payload_len + 4; /* +4 for CRC32 */
    if (total_len > LENS_SAVE_SLOT_SIZE) return;

    /* Align total write size to FLASH_PAGE_SIZE (256 bytes). */
    const size_t write_len = (total_len + FLASH_PAGE_SIZE - 1u)
                             & ~(size_t)(FLASH_PAGE_SIZE - 1u);

    /*
     * Reuse the pending-patch buffer as our page-aligned write buffer.
     * Core 1 is already reset at this point and g_pending is unused.
     * s_pending_buf is SOURCE_CAP (8192) bytes and already in BSS.
     * flash_range_program requires the source buffer to be in RAM.
     */
    uint8_t* buf = g_pending.bytes; /* points into s_pending_buf via g_pending */

    memset(buf, 0xFF, write_len);
    /* Write magic. */
    buf[0] = 'L'; buf[1] = 'E'; buf[2] = 'N'; buf[3] = 'S';
    /* Write build hash u32 LE; load rejects a mismatch (stale cross-build save). */
    buf[4] = (uint8_t)(g_build_hash & 0xFFu);
    buf[5] = (uint8_t)((g_build_hash >> 8) & 0xFFu);
    buf[6] = (uint8_t)((g_build_hash >> 16) & 0xFFu);
    buf[7] = (uint8_t)((g_build_hash >> 24) & 0xFFu);
    /* Write snapshot / pool lengths, u16 LE. */
    buf[8]  = (uint8_t)(snap_len & 0xFFu);
    buf[9]  = (uint8_t)((snap_len >> 8) & 0xFFu);
    buf[10] = (uint8_t)(nd_len & 0xFFu);
    buf[11] = (uint8_t)((nd_len >> 8) & 0xFFu);
    buf[12] = (uint8_t)(ct_len & 0xFFu);
    buf[13] = (uint8_t)((ct_len >> 8) & 0xFFu);
    /* Write snapshot bytes, then the live pools. */
    uint8_t* w = buf + HDR_LEN;
    memcpy(w, g_last_snapshot,    snap_len); w += snap_len;
    memcpy(w, lens_nodestate_pool, nd_len);  w += nd_len;
    memcpy(w, lens_control_pool,   ct_len);  w += ct_len;

    uint32_t final_crc = save_crc32(buf, payload_len);
    buf[payload_len + 0] = (uint8_t)(final_crc & 0xFFu);
    buf[payload_len + 1] = (uint8_t)((final_crc >> 8)  & 0xFFu);
    buf[payload_len + 2] = (uint8_t)((final_crc >> 16) & 0xFFu);
    buf[payload_len + 3] = (uint8_t)((final_crc >> 24) & 0xFFu);

    uint32_t save = save_and_disable_interrupts();
    flash_range_erase(LENS_SAVE_SLOT_OFF, LENS_SAVE_SLOT_SIZE);
    flash_range_program(LENS_SAVE_SLOT_OFF, buf, write_len);
    restore_interrupts(save);
}

static void do_flash_erase_slot(void) {
    uint32_t save = save_and_disable_interrupts();
    flash_range_erase(LENS_SAVE_SLOT_OFF, LENS_SAVE_SLOT_SIZE);
    restore_interrupts(save);
}

/* ---- LensCard ---- */

class LensCard : public ComputerCard {
public:
    LensCard() {}

    /* Exposes the protected ComputerCard CC-pin probe for role detection. */
    USBPowerState_t ReadUSBPowerState() { return USBPowerState(); }

    bool init() {
        struct LensRuntime* rt = nullptr;

        /* 1. Try user-saved snapshot from flash slot. */
        const uint8_t* slot = (const uint8_t*)LENS_SAVE_SLOT_XIP;
        bool slot_valid = false;
        if (slot[0]=='L' && slot[1]=='E' && slot[2]=='N' && slot[3]=='S') {
            uint32_t stored_hash = (uint32_t)slot[4] | ((uint32_t)slot[5] << 8)
                                 | ((uint32_t)slot[6] << 16) | ((uint32_t)slot[7] << 24);
            uint16_t slen   = (uint16_t)(slot[8]  | ((uint16_t)slot[9]  << 8));
            uint16_t nd_len = (uint16_t)(slot[10] | ((uint16_t)slot[11] << 8));
            uint16_t ct_len = (uint16_t)(slot[12] | ((uint16_t)slot[13] << 8));
            const size_t HDR_LEN = LENS_SAVE_HDR_LEN;
            /* Reject a snapshot saved by a different build (struct layout may have
             * changed): fall through to the baked factory instead of applying stale. */
            if (stored_hash == g_build_hash && slen > 0 && slen <= LENS_SNAPSHOT_CACHE
                && nd_len <= LENS_NODESTATE_BYTES && ct_len <= LENS_CONTROL_BUFFER_BYTES) {
                const size_t payload_len = HDR_LEN + slen + nd_len + ct_len;
                uint32_t stored_crc =
                    (uint32_t)slot[payload_len + 0]        |
                    ((uint32_t)slot[payload_len + 1] << 8)  |
                    ((uint32_t)slot[payload_len + 2] << 16) |
                    ((uint32_t)slot[payload_len + 3] << 24);
                uint32_t computed_crc = save_crc32(slot, payload_len);
                if (stored_crc == computed_crc) {
                    int rc = snapshot_apply(&rt, slot + HDR_LEN, slen);
                    g_apply_attempts++;
                    g_last_apply_rc = rc;
                    if (rc == 0) {
                        /* Overlay saved live state onto the freshly-applied (zeroed)
                           pools: same snapshot -> same offsets, so raw bytes line up.
                           Runs before the first ProcessSample, so ops see the restored
                           state (e.g. pickup keeps its taken-over value, not init). */
                        if (nd_len) memcpy(lens_nodestate_pool, slot + HDR_LEN + slen, nd_len);
                        if (ct_len) memcpy(lens_control_pool,   slot + HDR_LEN + slen + nd_len, ct_len);
                        memcpy(g_last_snapshot, slot + HDR_LEN, slen);
                        g_last_snapshot_len = slen;
                        g_snapshot_crc = snapshot_trailer_crc(slot + HDR_LEN, slen);
                        g_apply_count++;
                        g_rt = rt;
                        slot_valid = true;
                    }
                }
            }
        }

        /* 2. Fall back to baked factory snapshot. */
        if (!slot_valid) {
            rt = nullptr;
            int rc = snapshot_apply(&rt, lens_factory, lens_factory_len);
            g_apply_attempts++;
            g_last_apply_rc = rc;
            if (rc == 0) {
                size_t flen = lens_factory_len;
                if (flen > LENS_SNAPSHOT_CACHE) flen = LENS_SNAPSHOT_CACHE;
                memcpy(g_last_snapshot, lens_factory, flen);
                g_last_snapshot_len = (uint16_t)flen;
                g_snapshot_crc = snapshot_trailer_crc(lens_factory, lens_factory_len);
                g_apply_count++;
                g_rt = rt;
            } else {
                return false;
            }
        }
        return true;
    }

protected:
    /* ProcessSample is the audio ISR body; pinned to RAM. */
    void __not_in_flash_func(ProcessSample)() override {
#if LENS_PERF_PROBE
        uint32_t t0 = dwt_read();
#endif

        /* Click-free swap: defer the pending apply until the audio output is near a
         * zero crossing, with a short timeout so a sustained drone still swaps. The
         * jacks are driven by Core 0 (this ISR), so last sample's output is known
         * here; no cross-core read is needed. Combined with node-state preservation,
         * a same-layout edit swaps continuously and any residual parameter jump lands
         * quietly. (No crossfade: that would run two graphs at once, which the RAM
         * and CPU budget cannot spare.) */
        static int32_t  g_last_out_1 = 0;
        static int32_t  g_last_out_2 = 0;
        static uint32_t g_swap_wait  = 0;
        /* Master-clock beat tracking (updated after the walk, below) for beat/bar
           swap timing: g_beat_now marks a downbeat sample, g_beat_count counts
           beats since the current patch landed (so beat 4/8/12 = a bar boundary). */
        static int32_t  g_master_prev = 0;
        static uint32_t g_beat_count  = 0;
        static bool     g_beat_now    = false;
        constexpr int32_t  kSwapZeroThresh = 32;       /* on the +-2047 audio scale */
        constexpr uint32_t kSwapMaxWait    = 480;      /* ~10 ms at 48 kHz */
        constexpr uint32_t kSwapMaxWaitClk = 192000u;  /* ~4 s: fallback if the clock is stopped */
        {
        bool near_zero = (g_last_out_1 > -kSwapZeroThresh && g_last_out_1 < kSwapZeroThresh &&
                          g_last_out_2 > -kSwapZeroThresh && g_last_out_2 < kSwapZeroThresh);
        uint8_t mode = g_swap_mode;
        bool have_master = g_rt && g_rt->master_slot_idx != 0xFFFFu;
        bool boundary;
        uint32_t maxwait;
        if (mode == SWAP_AT_BEAT && have_master) {
            boundary = g_beat_now;                                 maxwait = kSwapMaxWaitClk;
        } else if (mode == SWAP_AT_BAR && have_master) {
            boundary = g_beat_now && (g_beat_count % 4u == 0u);    maxwait = kSwapMaxWaitClk;
        } else {
            boundary = near_zero;                                  maxwait = kSwapMaxWait;
        }
        if (g_pending.ready && (boundary || g_swap_wait >= maxwait)) {
            g_swap_wait = 0;
            __dmb();   /* pair with the Core 1 writer: read len after seeing ready */
            struct LensRuntime* new_rt = nullptr;
            size_t plen = g_pending.len;
            int rc = snapshot_apply(&new_rt, g_pending.bytes, plen);
            g_apply_attempts++;
            g_last_apply_rc = rc;
            if (rc == 0) {
                if (plen <= LENS_SNAPSHOT_CACHE) {
                    memcpy(g_last_snapshot, g_pending.bytes, plen);
                    g_last_snapshot_len = (uint16_t)plen;
                }
                g_snapshot_crc = snapshot_trailer_crc(g_pending.bytes, plen);
                g_apply_count++;
                g_last_apply_sample = g_rt ? g_rt->sample_counter : 0u;
                struct LensRuntime* old_rt = g_rt;
                g_rt = new_rt;
                if (old_rt) runtime_destroy(old_rt);
                /* New patch starts at its own downbeat: restart beat tracking. */
                g_master_prev = 0; g_beat_count = 0; g_beat_now = false;
            }
            g_pending.ready = false;
        } else if (g_pending.ready) {
            g_swap_wait++;   /* a swap is queued but no boundary reached yet */
        }
        }

        /* Handle CMD_SAVE_STATE: erase + write flash slot then reboot. */
        if (g_save_requested) {
            g_save_requested = false;
            multicore_reset_core1();
            do_flash_save();
            watchdog_reboot(0, 0, 0);
            for (;;) {} /* wait for watchdog */
        }

        /* Handle CMD_FACTORY_RESET: erase flash slot then reboot. */
        if (g_factory_reset_requested) {
            g_factory_reset_requested = false;
            multicore_reset_core1();
            do_flash_erase_slot();
            watchdog_reboot(0, 0, 0);
            for (;;) {}
        }

        struct LensRuntime* rt = g_rt;
        if (!rt) return;

        /* 1. Gather hardware inputs. */
#if LENS_PERF_PROBE
        uint32_t t_io_start = dwt_read();
#endif
        struct HardwareInputs hw_in;
        hw_in.knob_main  = KnobVal(Main);
        hw_in.knob_x     = KnobVal(X);
        hw_in.knob_y     = KnobVal(Y);
        hw_in.cv_in_1    = CVIn1() + VMID;
        hw_in.cv_in_2    = CVIn2() + VMID;
        hw_in.audio_in_1 = AudioIn1();
        hw_in.audio_in_2 = AudioIn2();
        hw_in.pulse_in_1 = PulseIn1() ? VMAX : 0;
        hw_in.pulse_in_2 = PulseIn2() ? VMAX : 0;
        hw_in.switch_pos = static_cast<int32_t>(SwitchVal());
        /* Jack-connection mask (normalisation probe), indexed to match hw_scratch. */
        hw_in.connected =
              (Connected(Input::Audio1) ? (1u << 0) : 0)
            | (Connected(Input::Audio2) ? (1u << 1) : 0)
            | (Connected(Input::Pulse1) ? (1u << 2) : 0)
            | (Connected(Input::Pulse2) ? (1u << 3) : 0)
            | (Connected(Input::CV1)    ? (1u << 4) : 0)
            | (Connected(Input::CV2)    ? (1u << 5) : 0);
#if LENS_PERF_PROBE
        uint32_t t_io_in_done = dwt_read();
#endif

        struct HardwareOutputs hw_out = {};

        /* 2. Run the audio slice. Kernels write their output during the walk;
         * recordhead_sweep applies any deferred tape writes at end-of-tick. */
#if LENS_PERF_PROBE
        uint32_t t_walk_start = dwt_read();
#endif
        /* Non-blocking dual-core: Core 0 NEVER waits for Core 1. It rings Core 1
         * each sample (Core 1 free-runs and processes the latest seq when it can),
         * then walks its own slots, commits its own recordheads, publishes its own
         * shadows, and drives outputs. If Core 1 is late (e.g. a USB burst), its
         * shadows simply hold last frame's value -- one more sample of lag on the
         * cross-core CV, never a stall. Each core only ever touches its own state,
         * and terminal feeders are pinned to Core 0, so the outputs are clean. A
         * patch with no Core 1 slots runs the same path; Core 1 just walks nothing. */
        {
            uint32_t seq = rt->sample_counter;
            runtime_update_hw_scratch(&hw_in);  /* both cores read scratch */
            __dmb();                            /* scratch + Core 0 shadows visible before ring */
            sio_hw->fifo_wr = seq;              /* triggers SIO_IRQ_PROC1 on Core 1 */
            runtime_walk_core0(rt, seq);
            recordhead_sweep_core0(rt);
            runtime_publish_shadows_core0(rt);
            runtime_drive_terminals(rt, &hw_out);
            rt->sample_counter = seq + 1;
        }

        /* Beat detect on the master clock for beat/bar-quantised live swaps: a rising
           edge through a low threshold marks the downbeat (one detector serves a ramp
           clock, which crosses just after its wrap, and a pulse, which crosses on
           arrival). Mirrors the runtime's own clock edge detector. */
        if (rt->master_slot_idx != 0xFFFFu && rt->master_slot_idx < rt->slot_count) {
            int32_t mv = *(volatile int32_t*)rt->slots[rt->master_slot_idx].out;
            constexpr int32_t kBeatLevel = VMAX / 16;
            g_beat_now = (mv > kBeatLevel) && (g_master_prev <= kBeatLevel);
            g_master_prev = mv;
            if (g_beat_now) g_beat_count++;
        } else {
            g_beat_now = false;
        }
#if LENS_PERF_PROBE
        uint32_t t_walk_done = dwt_read();
#endif

        /* Tempo blink on led-5 lives in the prelude as a default cable;
         * no main.cpp override needed. */

        /* 3b. Boot dance: L flipping with upside-down L (Γ) every 0.25 s.
         * ComputerCard LED indices:  0 1
         *                            2 3
         *                            4 5
         *   0x35 = {0,2,4,5}  upright L (left column + bottom-right foot)
         *   0x2B = {0,1,3,5}  inverted Γ (top row + right column + bottom-right)
         * 6 frames over kBootDanceSamples (~1.5 s).
         */
        if (g_boot_sample < kBootDanceSamples) {
            uint32_t frame = (g_boot_sample * 6u) / kBootDanceSamples; /* 0..5 */
            uint8_t  shape = (frame & 1u) ? 0x2Bu : 0x35u;
            hw_out.led_0 = (shape & 0x01u) ? VMAX : 0;
            hw_out.led_1 = (shape & 0x02u) ? VMAX : 0;
            hw_out.led_2 = (shape & 0x04u) ? VMAX : 0;
            hw_out.led_3 = (shape & 0x08u) ? VMAX : 0;
            hw_out.led_4 = (shape & 0x10u) ? VMAX : 0;
            hw_out.led_5 = (shape & 0x20u) ? VMAX : 0;
            g_boot_sample++;
        }

        /* 3c. Save-arm: Z-switch held DOWN ramps all LEDs (highest priority). */
        if (hw_in.switch_pos == 0) {
            if (g_save_arm_count < kSaveArmHoldSamples) {
                g_save_arm_count++;
            }
        } else {
            g_save_arm_count = 0u;
        }

        if (g_save_arm_count >= kSaveArmHoldSamples) {
            lens_request_save();
            g_save_arm_count = 0u;
        }

        if (g_save_arm_count > 0u) {
            /* 32-bit only: scale count into 0..VMAX without 64-bit multiply.
             * count/kSaveArmHoldSamples * VMAX = (count >> 6) * VMAX / (kSaveArmHoldSamples >> 6)
             * kSaveArmHoldSamples >> 6 = 3750; count >> 6 fits in 16 bits. */
            int32_t ramp = (int32_t)((g_save_arm_count >> 6) * (uint32_t)VMAX
                                     / (kSaveArmHoldSamples >> 6));
            hw_out.led_0 = ramp;
            hw_out.led_1 = ramp;
            hw_out.led_2 = ramp;
            hw_out.led_3 = ramp;
            hw_out.led_4 = ramp;
            hw_out.led_5 = ramp;
        }

        /* 4. Drive outputs. */

        /* Minimum pulse width: hold each pulse output high for at least 5 ms
           (~240 samples at 48 kHz) to guarantee Eurorack gear sees the trigger. */
        static uint32_t g_pulse_hold[2] = { 0, 0 };
        static bool     g_pulse_prev[2] = { false, false };
        constexpr uint32_t kPulseMinSamples = 240;

#if LENS_PERF_PROBE
        uint32_t t_io_out_start = dwt_read();
#endif
        AudioOut1(static_cast<int16_t>(hw_out.audio_out_1));
        AudioOut2(static_cast<int16_t>(hw_out.audio_out_2));
        /* Remember this sample's audio out so the next pending swap can wait for a
           zero crossing (see the click-free swap gate at the top of ProcessSample). */
        g_last_out_1 = hw_out.audio_out_1;
        g_last_out_2 = hw_out.audio_out_2;
        /* A pitch cv-out (source is v-oct) carries a MIDI note: use the card's
           per-unit calibrated 1V/oct path. Otherwise drive the raw value. */
        if (hw_out.cv_out_1_is_pitch) CVOut1MIDINote(static_cast<uint8_t>(hw_out.cv_out_1));
        else                          CVOut1(static_cast<int16_t>(hw_out.cv_out_1));
        if (hw_out.cv_out_2_is_pitch) CVOut2MIDINote(static_cast<uint8_t>(hw_out.cv_out_2));
        else                          CVOut2(static_cast<int16_t>(hw_out.cv_out_2));

        {
            bool high_now = hw_out.pulse_out_1 > VMID;
            if (high_now && !g_pulse_prev[0]) g_pulse_hold[0] = kPulseMinSamples;
            g_pulse_prev[0] = high_now;
            bool out = high_now || g_pulse_hold[0] > 0;
            if (g_pulse_hold[0] > 0) g_pulse_hold[0]--;
            PulseOut1(out);
        }
        {
            bool high_now = hw_out.pulse_out_2 > VMID;
            if (high_now && !g_pulse_prev[1]) g_pulse_hold[1] = kPulseMinSamples;
            g_pulse_prev[1] = high_now;
            bool out = high_now || g_pulse_hold[1] > 0;
            if (g_pulse_hold[1] > 0) g_pulse_hold[1]--;
            PulseOut2(out);
        }

        LedBrightness(0, static_cast<uint16_t>(hw_out.led_0));
        LedBrightness(1, static_cast<uint16_t>(hw_out.led_1));
        LedBrightness(2, static_cast<uint16_t>(hw_out.led_2));
        LedBrightness(3, static_cast<uint16_t>(hw_out.led_3));
        LedBrightness(4, static_cast<uint16_t>(hw_out.led_4));
        LedBrightness(5, static_cast<uint16_t>(hw_out.led_5));

#if LENS_PERF_PROBE
        /* SysTick is a 24-bit DOWN counter: elapsed = (start - end) & 0xFFFFFF. */
        uint32_t t_end = dwt_read();
        uint32_t c_walk  = (t_walk_start - t_walk_done) & 0x00FFFFFFu;
        uint32_t c_io    = ((t_io_start    - t_io_in_done)   & 0x00FFFFFFu)
                         + ((t_io_out_start - t_end)          & 0x00FFFFFFu);
        uint32_t c_total = (t0 - t_end) & 0x00FFFFFFu;
        struct PerfRingEntry* e = &perf_ring[perf_head & 1023u];
        e->walk  = c_walk  > 0xFFFFu ? 0xFFFFu : (uint16_t)c_walk;
        e->io    = c_io    > 0xFFFFu ? 0xFFFFu : (uint16_t)c_io;
        e->total = c_total > 0xFFFFu ? 0xFFFFu : (uint16_t)c_total;
        perf_head++;
#endif
    }
};

/* ---- Core 1: TinyUSB + audio slice via FIFO doorbell ---- */

/*
 * SIO FIFO doorbell IRQ. Core 0 writes the sample sequence number to the FIFO
 * each sample; this IRQ drains to the latest seq and runs Core 1's walk. The
 * IRQ priority is set BELOW TinyUSB (0xC0 vs USB's 0x80) because a dropped
 * USB MIDI byte cannot be recovered (sysex parser desyncs and the whole
 * patch transfer corrupts), while a late audio slice just trips Core 0's
 * spin budget and the sample drops cleanly via the one-sample-lag semantics.
 */
/* Diagnostic: how many times Core 1 has actually run its walk. Reported in PERF so
   we can tell a real dual-core run (>0) from a silent Core 1 (==0). */
static volatile uint32_t g_core1_loops = 0;

static void __not_in_flash_func(core1_doorbell_irq)(void) {
    uint32_t seq = 0;
    bool got = false;
    while (multicore_fifo_rvalid()) { seq = sio_hw->fifo_rd; got = true; }
    multicore_fifo_clear_irq();
    if (!got) return;
    struct LensRuntime* rt = g_rt;
    if (rt) {
        /* Self-contained frame: walk Core 1's slots, commit ITS recordheads, and
         * publish ITS shadows. Core 0 only ever reads these shadows, never Core 1's
         * live state, so there is nothing for Core 0 to wait on. */
        runtime_walk_core1(rt, seq);
        recordhead_sweep_core1(rt);
        runtime_publish_shadows_core1(rt);
        g_core1_loops++;
        rt->core1_done = seq;
    }
}

/* The host MIDI driver calls this (weak) when a mounted device has RX packets.
 * Drain the decoded byte stream straight into the transport-independent parser. */
extern "C" void tuh_midi_rx_cb(uint8_t dev_addr, uint32_t num_packets) {
    (void)num_packets;
    uint8_t cable;
    uint8_t buf[64];
    uint32_t n;
    while ((n = tuh_midi_stream_read(dev_addr, &cable, buf, sizeof(buf))) > 0)
        for (uint32_t i = 0; i < n; i++) midi_feed_byte(buf[i]);
}

/* ---- USB foreground loops (called from core1_entry) ---- */

/* Host loop: tuh_task drives enumeration; tuh_midi_rx_cb feeds the parser.
 * Run-loop split credited to Music Thing Workshop System 33_drumdrum. */
static void run_host_loop(void) {
    while (true) {
        tuh_task();
    }
}

/* Device loop: SysEx CLI + DAW MIDI over the USB device stack. */
static void run_device_loop(void) {
    /* ParserState carries a ~9 KB wire_buf; Core 1's stack is 2 KB.
     * Static keeps it in BSS. */
    static lenssysex::ParserState parser;
    lenssysex::init(&parser);

    while (true) {
        tud_task();

        /* Drain incoming MIDI as a decoded byte stream. tud_midi_stream_read
         * handles USB MIDI CIN tags and yields pure data bytes, including
         * CIN=0xF which macOS CoreMIDI uses to fragment large sysex transfers. */
        uint8_t in_buf[64];
        while (tud_midi_available()) {
            uint32_t n = tud_midi_stream_read(in_buf, sizeof(in_buf));
            for (uint32_t bi = 0; bi < n; bi++) {
                midi_feed_byte(in_buf[bi]);
                if (lenssysex::feed_byte(&parser, in_buf[bi])) {
                    /* Complete frame received. */
                    uint8_t cmd = lenssysex::get_command(&parser);
                    switch (cmd) {

                    case lenssysex::CMD_WRITE_STATE:
                        if (g_pending.ready) {
                            /* Previous patch still queued; reject to avoid overwrite. */
                            lenssysex::sysex_send_nack(lenssysex::CMD_WRITE_STATE,
                                                        lenssysex::NACK_BUSY);
                        } else {
                            size_t plen = lenssysex::get_payload(
                                    &parser, g_pending.bytes, lenssysex::SOURCE_CAP);
                            if (plen > 0) {
                                g_pending.len   = plen;
                                __dmb();   /* len visible before Core 0 observes ready */
                                g_pending.ready = true;
                                /* ACK after queuing; Core 0 applies on next sample. */
                                lenssysex::sysex_send_frame(lenssysex::CMD_ACK, nullptr, 0);
                            } else {
                                lenssysex::sysex_send_nack(lenssysex::CMD_WRITE_STATE,
                                                            lenssysex::NACK_BAD_LENGTH);
                            }
                        }
                        break;

                    case lenssysex::CMD_PING:
                        lenssysex::sysex_send_frame(lenssysex::CMD_ACK, nullptr, 0);
                        break;

                    case lenssysex::CMD_SWAP_MODE: {
                        /* 1 payload byte selects when a live WRITE_STATE swaps in:
                           0 = next near-zero sample, 1 = next beat, 2 = next bar. */
                        uint8_t mb[1];
                        size_t n = lenssysex::get_payload(&parser, mb, sizeof(mb));
                        if (n >= 1 && mb[0] <= SWAP_AT_BAR) g_swap_mode = mb[0];
                        lenssysex::sysex_send_frame(lenssysex::CMD_ACK, nullptr, 0);
                        break;
                    }

                    case lenssysex::CMD_DIAG: {
                        /* DIAG_DUMP payload (v2):
                           ver u8, _pad u8, _pad u16,
                           build_hash u32, snapshot_crc u32,
                           last_apply_rc i32, apply_count u32, apply_attempts u32,
                           pending_ready u8, _pad u8, pending_len u16,
                           sample_counter u32, last_apply_sample u32,
                           snapshot_len u16, _pad u16,
                           core1_done u32,                                  = 44 bytes (identity block)
                           cycles_avg_total u32, cycles_max_total u32,
                           cycles_avg_walk u32, cycles_avg_io u32,
                           sysclk_hz u32, samples_window u32               = 24 bytes (perf block)
                                                                            = 68 bytes total
                           perf fields are zero when LENS_PERF_PROBE=0 */
                        uint8_t d[68]; size_t i = 0;
                        auto u32 = [&](uint32_t v) {
                            d[i++] = (uint8_t)v; d[i++] = (uint8_t)(v >> 8);
                            d[i++] = (uint8_t)(v >> 16); d[i++] = (uint8_t)(v >> 24);
                        };
                        auto u16 = [&](uint16_t v) {
                            d[i++] = (uint8_t)v; d[i++] = (uint8_t)(v >> 8);
                        };
                        struct LensRuntime* rt = g_rt;
                        uint32_t scnt = rt ? rt->sample_counter : 0u;
                        uint32_t c1d  = rt ? rt->core1_done      : 0u;
                        d[i++] = 2; d[i++] = 0; d[i++] = 0; d[i++] = 0;
                        u32(g_build_hash);
                        u32(g_snapshot_crc);
                        u32((uint32_t)g_last_apply_rc);
                        u32(g_apply_count);
                        u32(g_apply_attempts);
                        d[i++] = g_pending.ready ? 1u : 0u;
                        d[i++] = 0;
                        u16((uint16_t)g_pending.len);
                        u32(scnt);
                        u32(g_last_apply_sample);
                        u16(g_last_snapshot_len);
                        u16(0);
                        u32(c1d);
#if LENS_PERF_PROBE
                        {
                            uint32_t head    = *lens_perf_head_p;
                            uint32_t count_n = head < lens_perf_ring_len
                                             ? head : lens_perf_ring_len;
                            uint32_t sum_total = 0, mx_total = 0;
                            uint32_t sum_walk  = 0, sum_io   = 0;
                            uint32_t pstart = (head >= lens_perf_ring_len)
                                            ? (head & 1023u) : 0u;
                            for (uint32_t k = 0; k < count_n; k++) {
                                const volatile struct PerfRingEntry* e =
                                    &lens_perf_ring[(pstart + k) & 1023u];
                                uint32_t t  = e->total;
                                uint32_t w  = e->walk;
                                uint32_t io = e->io;
                                sum_total += t;
                                sum_walk  += w;
                                sum_io    += io;
                                if (t > mx_total) mx_total = t;
                            }
                            u32(count_n ? (sum_total / count_n) : 0u);
                            u32(mx_total);
                            u32(count_n ? (sum_walk  / count_n) : 0u);
                            u32(count_n ? (sum_io    / count_n) : 0u);
                            u32(clock_get_hz(clk_sys));
                            u32(count_n);
                        }
#else
                        u32(0); u32(0); u32(0); u32(0); u32(0); u32(0);
#endif
                        lenssysex::sysex_send_frame(lenssysex::CMD_DIAG_DUMP, d, sizeof(d));
                        break;
                    }

                    case lenssysex::CMD_SAVE_STATE:
                        /* ACK first, then signal Core 0 to perform the flash write. */
                        lenssysex::sysex_send_frame(lenssysex::CMD_ACK, nullptr, 0);
                        lens_request_save();
                        break;

                    case lenssysex::CMD_FACTORY_RESET:
                        lenssysex::sysex_send_frame(lenssysex::CMD_ACK, nullptr, 0);
                        lens_request_factory_reset();
                        break;

                    case lenssysex::CMD_READ_PERF: {
#if LENS_PERF_PROBE
                        /* Snapshot ring under Core 1 (ring written by Core 0; each
                           PerfRingEntry is 6 bytes; the three uint16_t writes are not
                           guaranteed atomic, but perf data is diagnostic only). */
                        uint32_t head = *lens_perf_head_p;
                        uint32_t count_n = head < lens_perf_ring_len
                                         ? head : lens_perf_ring_len;
                        uint32_t sum_total = 0, mx_total = 0;
                        uint32_t sum_walk  = 0, sum_io   = 0;
                        uint32_t start = (head >= lens_perf_ring_len)
                                       ? (head & 1023u) : 0u;
                        for (uint32_t k = 0; k < count_n; k++) {
                            const volatile struct PerfRingEntry* e =
                                &lens_perf_ring[(start + k) & 1023u];
                            uint32_t t = e->total;
                            uint32_t w = e->walk;
                            uint32_t io = e->io;
                            sum_total += t;
                            sum_walk  += w;
                            sum_io    += io;
                            if (t > mx_total) mx_total = t;
                        }
                        uint32_t avg = count_n ? (sum_total / count_n) : 0u;
                        uint32_t mx  = mx_total;
                        uint32_t avg_walk = count_n ? (sum_walk / count_n) : 0u;
                        uint32_t avg_io   = count_n ? (sum_io   / count_n) : 0u;

                        /* Response payload (PERF_DUMP):
                           ver u8, sec_count u8, count u16, reserved u16, reserved u16,
                           sysclk u32, samples u32, reserved u32, core1_loops u32,
                           total_avg u32, total_max u32, reserved u32, reserved u32,
                           walk_avg u32, io_avg u32  (sec_count=2 sections). */
                        uint8_t perf[48];
                        size_t  pi = 0;
                        perf[pi++] = 1;          /* ver */
                        perf[pi++] = 2;          /* sec_count: walk + io */
                        perf[pi++] = (uint8_t)(count_n & 0xFFu);
                        perf[pi++] = (uint8_t)((count_n >> 8) & 0xFFu); /* count u16 */
                        perf[pi++] = 0; perf[pi++] = 0;                 /* reserved u16 */
                        perf[pi++] = 0; perf[pi++] = 0;                 /* reserved u16 */
                        /* sysclk u32 = 250_000_000 = 0x0EE6B280 LE */
                        perf[pi++] = 0x80; perf[pi++] = 0xB2; perf[pi++] = 0xE6; perf[pi++] = 0x0E;
                        /* samples = head */
                        perf[pi++] = (uint8_t)(head & 0xFFu);
                        perf[pi++] = (uint8_t)((head >> 8)  & 0xFFu);
                        perf[pi++] = (uint8_t)((head >> 16) & 0xFFu);
                        perf[pi++] = (uint8_t)((head >> 24) & 0xFFu);
                        /* reserved u32 */
                        perf[pi++] = 0; perf[pi++] = 0; perf[pi++] = 0; perf[pi++] = 0;
                        /* core1_loops: real count of Core 1 walks since boot */
                        { uint32_t cl = g_core1_loops;
                          perf[pi++] = (uint8_t)(cl & 0xFFu);       perf[pi++] = (uint8_t)((cl >> 8) & 0xFFu);
                          perf[pi++] = (uint8_t)((cl >> 16) & 0xFFu); perf[pi++] = (uint8_t)((cl >> 24) & 0xFFu); }
                        /* total_avg */
                        perf[pi++] = (uint8_t)(avg & 0xFFu);
                        perf[pi++] = (uint8_t)((avg >> 8)  & 0xFFu);
                        perf[pi++] = (uint8_t)((avg >> 16) & 0xFFu);
                        perf[pi++] = (uint8_t)((avg >> 24) & 0xFFu);
                        /* total_max */
                        perf[pi++] = (uint8_t)(mx & 0xFFu);
                        perf[pi++] = (uint8_t)((mx >> 8)  & 0xFFu);
                        perf[pi++] = (uint8_t)((mx >> 16) & 0xFFu);
                        perf[pi++] = (uint8_t)((mx >> 24) & 0xFFu);
                        /* reserved u32 x2 */
                        perf[pi++] = 0; perf[pi++] = 0; perf[pi++] = 0; perf[pi++] = 0;
                        perf[pi++] = 0; perf[pi++] = 0; perf[pi++] = 0; perf[pi++] = 0;
                        /* section averages: walk_avg, io_avg */
                        perf[pi++] = (uint8_t)(avg_walk & 0xFFu);
                        perf[pi++] = (uint8_t)((avg_walk >> 8)  & 0xFFu);
                        perf[pi++] = (uint8_t)((avg_walk >> 16) & 0xFFu);
                        perf[pi++] = (uint8_t)((avg_walk >> 24) & 0xFFu);
                        perf[pi++] = (uint8_t)(avg_io & 0xFFu);
                        perf[pi++] = (uint8_t)((avg_io >> 8)  & 0xFFu);
                        perf[pi++] = (uint8_t)((avg_io >> 16) & 0xFFu);
                        perf[pi++] = (uint8_t)((avg_io >> 24) & 0xFFu);
                        lenssysex::sysex_send_frame(lenssysex::CMD_PERF_DUMP, perf, pi);
#else
                        /* SPEC: perf ring not compiled in; reply ACK stub. */
                        lenssysex::sysex_send_frame(lenssysex::CMD_ACK, nullptr, 0);
#endif
                        break;
                    }

                    case lenssysex::CMD_SLOT_PERF: {
#if LENS_PERF_PROBE
                        struct LensRuntime* rt = g_rt;
                        uint16_t sc = rt ? rt->slot_count : 0u;
                        /* Payload: u16 slot_count, then per slot { u32 total, u32 max, u32 calls }
                           = 2 + sc*12 bytes. Cap at LENS_MAX_SLOTS. */
                        if (sc > LENS_MAX_SLOTS) sc = LENS_MAX_SLOTS;
                        const size_t payload_len = 2u + (size_t)sc * 12u;
                        /* Use a static buffer; 2 + 256*12 = 3074 bytes. */
                        static uint8_t slot_perf_buf[2 + LENS_MAX_SLOTS * 12];
                        slot_perf_buf[0] = (uint8_t)(sc & 0xFFu);
                        slot_perf_buf[1] = (uint8_t)((sc >> 8) & 0xFFu);
                        for (uint16_t si = 0; si < sc; si++) {
                            size_t o = 2u + (size_t)si * 12u;
                            uint32_t tot = rt->slot_cycle_total[si];
                            uint32_t mx  = rt->slot_cycle_max[si];
                            uint32_t cnt = rt->slot_call_count[si];
                            slot_perf_buf[o+ 0] = (uint8_t)(tot);
                            slot_perf_buf[o+ 1] = (uint8_t)(tot >> 8);
                            slot_perf_buf[o+ 2] = (uint8_t)(tot >> 16);
                            slot_perf_buf[o+ 3] = (uint8_t)(tot >> 24);
                            slot_perf_buf[o+ 4] = (uint8_t)(mx);
                            slot_perf_buf[o+ 5] = (uint8_t)(mx  >> 8);
                            slot_perf_buf[o+ 6] = (uint8_t)(mx  >> 16);
                            slot_perf_buf[o+ 7] = (uint8_t)(mx  >> 24);
                            slot_perf_buf[o+ 8] = (uint8_t)(cnt);
                            slot_perf_buf[o+ 9] = (uint8_t)(cnt >> 8);
                            slot_perf_buf[o+10] = (uint8_t)(cnt >> 16);
                            slot_perf_buf[o+11] = (uint8_t)(cnt >> 24);
                        }
                        lenssysex::sysex_send_frame(lenssysex::CMD_SLOT_PERF_DUMP,
                                                     slot_perf_buf, payload_len);
#else
                        lenssysex::sysex_send_frame(lenssysex::CMD_ACK, nullptr, 0);
#endif
                        break;
                    }

                    default:
                        /* Unknown command: NACK with reason. */
                        lenssysex::sysex_send_nack(cmd, lenssysex::NACK_UNKNOWN_CMD);
                        break;
                    }
                }
            }
        }

        /* Drain MIDI output ring -> USB MIDI TX (device-only). */
        if (tud_midi_mounted()) {
            uint8_t midi_tx_buf[4];
            uint8_t midi_tx_len;
            while ((midi_tx_len = midi_out_pop(midi_tx_buf)) > 0)
                tud_midi_stream_write(0, midi_tx_buf, midi_tx_len);
        }

        /* Audio work is in the FIFO doorbell IRQ (see core1_doorbell_irq).
         * The foreground loop owns USB only. */
    }
}

/* The app-level MIDI host driver registers itself: usb_midi_host_app_driver.c
 * provides usbh_app_driver_get_cb, called once during tuh_rhport_init. */

/* ---- Core 1 entry ---- */

static void __not_in_flash_func(core1_entry)(void) {
    /* USB stack init runs on Core 1 so the USB IRQ lands on Core 1's NVIC.
     * board_init() runs here in host mode, on Core 0 in device mode (role split
     * below and in main()). 33_drumdrum inits the device stack on Core 0 instead.
     * RHPORT0 is HOST|DEVICE, so tusb_init() (not tuh_init) configures the
     * controller for the chosen role (per 33_drumdrum). */
    bool host = (bool)g_usb_host_mode;
    if (host) { board_init(); tusb_init(); } else tud_init(0);

    multicore_fifo_clear_irq();
    irq_set_exclusive_handler(SIO_IRQ_PROC1, core1_doorbell_irq);
    irq_set_priority(SIO_IRQ_PROC1, 0xC0);
    irq_set_enabled(SIO_IRQ_PROC1, true);

    midi_reset();

    if (host) run_host_loop(); else run_device_loop();
}

/* ---- main ---- */

int main(void) {
    /* SPEC: 250 MHz overclock at 1.15 V per spec line 75.
     * Regulator must settle before the PLL jump (prototype pattern). */
    vreg_set_voltage(VREG_VOLTAGE_1_15);
    sleep_ms(1);
    set_sys_clock_khz(250000, true);

    /*
     * Construct LensCard + apply factory snapshot BEFORE Core 1 launches.
     * Otherwise Core 1 calls tud_init while Core 0 is still in
     * ComputerCard's constructor, racing the USB peripheral setup.
     */
    static LensCard card;
    card.init();
    card.EnableNormalisationProbe();
    dwt_enable();

    /* Read USB-C CC pins to select USB role for this power cycle.
     * DFP = a downstream device (keyboard) is plugged in = host mode.
     * UFP (computer) or Unsupported (non-Rev1_1 board) = device mode.
     * Detection runs on Core 0 before Core 1 launches; USB init is deferred to Core 1.
     * Role-detection approach credited to Music Thing Workshop System 33_drumdrum. */
    g_usb_host_mode = (card.ReadUSBPowerState() == ComputerCard::DFP) ? 1u : 0u;

    /* board_init() (rp2040 USB hardware bring-up) runs on Core 0 in device mode;
     * in host mode Core 1 runs it, so Core 0 skips it here. */
    if (!g_usb_host_mode) board_init();
    multicore_launch_core1(core1_entry);

    card.Run(); /* never returns */
    return 0;
}
