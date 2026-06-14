// main.cpp. Host/glue for the Loupe runtime: ComputerCard wiring, dual-core split
// (Core 0 = audio interrupt + its share of the graph; Core 1 = USB + the rest),
// save/SysEx bridge, and the by-ear-tuned pitch/rate tables.

#include "ComputerCard.h"
#include "pico/stdlib.h"
#include "hardware/flash.h"
#include "hardware/sync.h"
#include "hardware/watchdog.h"
#include "hardware/clocks.h"
#include "hardware/structs/systick.h"
#include "hardware/vreg.h"
#include "pico/multicore.h"
#include "bsp/board_api.h"      // board_init only; TinyUSB lives entirely on Core 1
#include <math.h>
#include <string.h>

#include "tape.h"
#include "expression.h"
#include "loupe.h"
#include "snapshot.h"
#include "default_snapshot.h"
#include "lens_state.h"
#include "usb_core1.h"

using namespace loupe;

static constexpr uint32_t kSaveMagic   = 0x4C454E53u;   // 'LENS'
// Must match SAVE_VERSION in compile.js. Mismatched saves are rejected (no migrations).
static constexpr uint32_t kSaveVersion = 0x00050006u;
// Saved snapshot lives at the end of flash: [u32 length][snapshot] rounded to whole sectors.
static constexpr size_t   kSavePageBytes = ((4 + LENS_MAX_SNAPSHOT + FLASH_SECTOR_SIZE - 1)
                                            / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE;
static constexpr uint32_t kSaveOffset    = PICO_FLASH_SIZE_BYTES - kSavePageBytes;

static constexpr int32_t  kDefaultMasterXStored = 1024;
static constexpr int       kMasterPage          = 4;
static constexpr uint32_t  kPageTapUs  =  400000;
static constexpr uint32_t  kSaveHoldUs = 5000000;            // ~5 s DOWN = save
static constexpr int32_t   kPickupThreshold     = 60;
static constexpr int       kBootSettleSnaps     = 800;
static constexpr uint32_t kWaveBasePhaseInc     = 5852657u;
static constexpr int32_t  kPitchInBaseNote      = 36;
static constexpr int32_t  kPulseSamples         = 240;         // ~5 ms


class Lens : public ComputerCard
{
public:
    Lens()
    {
        rng_state_     = 0xC0FFEE17u;
        active_page_   = 0;
        pending_apply_ = false;

        BuildPitchTable();
        BuildRateTable();
        BuildRatioTable();
        InitDefaults();

        // SysTick free-runs as a 24-bit down counter; cache sysclk outside the audio IRQ.
        perf_pub_.sysclk_hz = clock_get_hz(clk_sys);
        systick_hw->rvr = 0x00FFFFFF;
        systick_hw->cvr = 0;
        systick_hw->csr = M0PLUS_SYST_CSR_CLKSOURCE_BITS | M0PLUS_SYST_CSR_ENABLE_BITS;
    }

    // 48 kHz audio interrupt (Core 0). Budget ~20 us. RAM-pinned: no XIP stalls on the
    // per-sample path. Hot helpers must inline here or also be __not_in_flash_func.
    virtual void __not_in_flash_func(ProcessSample)()
    {
        // Flash writes happen ONLY here, with Core 1 reset first. Never returns.
        if (flash_op_req_) DoFlashOpAndReboot(flash_op_req_);

        // Staged patch applies at a quiet moment (both audio jacks near zero), ~50 ms timeout.
        if (pending_apply_)
        {
            const int32_t a0 = last_audio_[0] < 0 ? -last_audio_[0] : last_audio_[0];
            const int32_t a1 = last_audio_[1] < 0 ? -last_audio_[1] : last_audio_[1];
            if ((a0 < kApplyQuiet && a1 < kApplyQuiet) || ++pending_wait_ > kApplyTimeout)
            {
                pending_wait_ = 0;
                // Let Core 1 finish its in-flight slice before the graph is rebuilt under it.
                for (int i = 0; i < 8000 && c1_.done != c1_.db_seq; ++i) __asm volatile("nop");
                ApplyPendingState();
            }
        }

        const uint32_t t0 = systick_hw->cvr;

        // Per-sample evaluation. Publish ctx, ring Core 1's doorbell, run our must-run share,
        // then the control slice. Never wait on Core 1: a late slice holds its values one sample.
        ctx0_.audio_in[0] = AudioIn1();
        ctx0_.audio_in[1] = AudioIn2();
        if (schedule_.must > 0) FireDoorbell();
        RunMust(schedule_, ctx0_, 0);
        CtrlSlice cs = RunCtrl(schedule_, ctx0_, schedule_.stride);
        CommitMust(schedule_, 0);
        CommitCtrl(schedule_, cs);
        // Commit Core 1's freshest completed slice (advance, not this-sample) so its nodes
        // have a fixed one-sample pipeline.
        CommitCore1Slice();

        const uint32_t t1 = systick_hw->cvr;

        DriveJacks();
        const uint32_t t2 = systick_hw->cvr;
        WriteRecordheads();
        const uint32_t t3 = systick_hw->cvr;

        // Hardware-edge round-robin: ADC mux needs settling, LED PWM doesn't need every sample.
        switch (io_turn_)
        {
            case 0: TakeInputSnapshot();   break;
            case 1: HandlePanelGestures();  break;
            case 2: RenderNextLed();        break;
        }
        if (++io_turn_ >= kIoTasks) io_turn_ = 0;
        if (boot_dance_ > 0) --boot_dance_;

        const uint32_t t4 = systick_hw->cvr;
        const uint32_t d[kPerfSections] = {
            (t0 - t1) & 0xFFFFFF, (t1 - t2) & 0xFFFFFF,
            (t2 - t3) & 0xFFFFFF, (t3 - t4) & 0xFFFFFF };
        for (int s = 0; s < kPerfSections; ++s)
        {
            perf_sum_[s] += d[s];
            if (d[s] > perf_max_[s]) perf_max_[s] = d[s];
        }
        const uint32_t dt = (t0 - t4) & 0xFFFFFF;
        perf_tsum_ += dt;
        if (dt > perf_tmax_) perf_tmax_ = dt;
        ++perf_samples_;
        if (++perf_n_ >= (uint32_t)kPerfBlock) PerfPublish();
    }

    void __not_in_flash_func(DriveJacks)()
    {
        for (int j = 0; j < kNumOutputs; ++j) DriveJack(j, term_.jack[j]);
    }

    // Jacks 0,1 = CV (signal/cv terminal or pitch note); 2,3 = audio; 4,5 = pulse.
    // Pulse fires on the terminal's RISING EDGE; gate terminals hold the level.
    void __not_in_flash_func(DriveJack)(int j, int16_t terminal)
    {
        const Node* tf = (terminal >= 0) ? &graph_.nodes[terminal] : nullptr;
        int32_t tv = (terminal >= 0) ? graph_state_.nodes[terminal].value : 0;
        if (j < 2)
        {
            if (tf && tf->is_signal)             out_cv_[j] = tv;
            else if (tf && tf->kind == NODE_CV)  out_cv_[j] = CvToDac(tv, tf->param);
            else { out_note_[j] = (tv < 0) ? 0 : (tv > 127) ? 127 : tv; CVOutMIDINote(j, (uint8_t)out_note_[j]); return; }
            int16_t v = (int16_t)out_cv_[j]; if (j == 0) CVOut1(v); else CVOut2(v);
        }

        else if (j < 4)
        {
            int32_t s = (tf && tf->is_signal) ? tv : 0;
            last_audio_[j - 2] = (int16_t)s;
            if (j == 2) AudioOut1((int16_t)s); else AudioOut2((int16_t)s);
        }

        else
        {
            // Level terminal holds the jack high; one-shot tick arms kPulseSamples minimum so
            // external gear sees the trigger; a `gate` node keeps its computed width exactly.
            uint8_t level = 0;
            if (tf)
            {
                uint8_t high = tv > VMID;
                if (high && !pulse_high_[j])
                {
                    int32_t w = kPulseSamples;
                    if (tf->kind == NODE_GATE) {
                        int32_t len = (tf->param_from >= 0)
                                    ? graph_state_.nodes[tf->param_from].value
                                    : (int32_t)tf->param;
                        w = PulseWidth(len, spb_, kPulseSamples);
                    }
                    out_pulse_[j] = w;
                }
                pulse_high_[j] = high;
                if (tf->kind != NODE_GATE) level = high;
            }
            bool ph = out_pulse_[j] > 0 || level;
            if (j == 4) PulseOut1(ph); else PulseOut2(ph);
            if (out_pulse_[j] > 0) out_pulse_[j]--;
        }
    }

    // On RecAdvanced: control tape writes settled value at the position the head just left;
    // audio tape (clock_div > 0) is write-through at the sweep position. Frozen tapes reject.
    void __not_in_flash_func(WriteRecordheads)()
    {
        for (int r = 0; r < term_.rec_count; ++r)
        {
            int t = term_.rec_tape[r];
            int16_t rt = term_.rec[r];
            if (t < 0 || t >= tape_count_ || rt < 0 || tapes_[t].frozen || !tapes_[t].length) continue;
            const Node& tf = graph_.nodes[rt];
            bool sweep = tapes_[t].clock_div > 0;
            int32_t pos = sweep
                ? WriteHead(graph_state_, tf.clock_from, (int32_t)tapes_[t].length)
                : HeadPos(graph_state_, tf.clock_from, (int32_t)tapes_[t].length);
            uint32_t wr = (tf.clock_from >= 0) ? graph_state_.nodes[tf.clock_from].wraps : 0u;
            int32_t prev_pos = rec_gate_[r].pos, settled = rec_gate_[r].last;
            bool adv = RecAdvanced(rec_gate_[r], pos, wr);
            int32_t v = graph_state_.nodes[rt].value;
            if (tf.is_signal) v = sig2v(v);
            rec_gate_[r].last = v;
            if (!adv) continue;
            if (sweep) WriteElem(live_, (int)tapes_[t].start, pos, v);
            else       WriteElem(live_, (int)tapes_[t].start, prev_pos, settled);
        }
    }


    // Soft pickup: a stored knob only tracks the pot once the pot has moved past
    // kPickupThreshold from where it sat at page entry.
    static inline void UpdatePickup(int32_t& stored, int32_t snapshot, bool& active, int32_t phys)
    {
        if (!active)
        {
            int32_t delta = phys - snapshot;
            if (delta < 0) delta = -delta;
            if (delta > kPickupThreshold) active = true;
        }
        if (active) stored = phys;
    }

    // Snapshot the pots and clear active flags so they must each move past the threshold.
    void ArmPageEntry()
    {
        if (active_page_ == kMasterPage)
        {
            master_main_snapshot_ = cur_phys_main_; master_main_active_ = false;
            master_x_snapshot_    = cur_phys_x_;    master_x_active_    = false;
            master_y_snapshot_    = cur_phys_y_;    master_y_active_    = false;
        }
        else
        {
            Tape& t = tapes_[active_page_];
            t.main_snapshot = cur_phys_main_; t.main_active = false;
            t.x_snapshot    = cur_phys_x_;    t.x_active    = false;
            t.y_snapshot    = cur_phys_y_;    t.y_active    = false;
        }
    }

    // Read panel + jacks into the snapshot the interpreters see. The three pots ARE
    // (knob :main/:x/:y), raw; master_x/master_y are patch-level snapshot seeds, never pots.
    void TakeInputSnapshot()
    {
        int32_t kmain = KnobVal(Knob::Main), kx = KnobVal(Knob::X), ky = KnobVal(Knob::Y);
        cur_phys_main_ = kmain; cur_phys_x_ = kx; cur_phys_y_ = ky;

        snapshot_.knob_main = kmain;
        snapshot_.knob_x    = kx;
        snapshot_.knob_y    = ky;
        snapshot_.master_x  = master_x_;
        snapshot_.master_y  = master_y_;
        snapshot_.cv_in[0]  = CVIn1();
        snapshot_.cv_in[1]  = CVIn2();
        snapshot_.pulse_in[0] = PulseIn1();
        snapshot_.pulse_in[1] = PulseIn2();
        for (int k = 0; k < 6; ++k) snapshot_.connected[k] = Connected((Input)k);
        snapshot_.active_page = (int8_t)active_page_;
    }

    // Render ONE LED per call (round-robin).
    void __not_in_flash_func(RenderNextLed)()
    {
        int l = led_turn_;
        if (++led_turn_ >= 6) led_turn_ = 0;
        // Patch-load dance: an "L" flipping between right-way-up and upside-down (2x3 grid,
        // 0 1 / 2 3 / 4 5; 0x35={0,2,4,5}, 0x2B={0,1,3,5}).
        if (boot_dance_ > 0)
        {
            int elapsed   = kDanceSamples - boot_dance_;
            int frame     = (elapsed * 6) / kDanceSamples;
            uint8_t shape = (frame & 1) ? 0x2B : 0x35;
            LedBrightness(l, (shape & (1u << l)) ? 4095 : 0);
            return;
        }
        // Save-arming overrides the patch: every LED shows the rising ramp brightness.
        if (save_ramp_) { LedBrightness(l, save_ramp_); return; }
        int16_t lt = term_.led[l];
        if (lt < 0) { LedOff(l); return; }
        const Node& tf = graph_.nodes[lt];
        int32_t v = graph_state_.nodes[lt].value;
        // Signals are bipolar in [-SMAX..SMAX]; doubling the magnitude maps the full
        // swing onto the 12-bit PWM range. Unipolar values are already 0..VMAX.
        int32_t bri = tf.is_signal ? ((v < 0 ? -v : v) << 1) : (v < 0 ? 0 : v);
        if (bri > VMAX) bri = VMAX;
        LedBrightness(l, (uint16_t)bri);
    }

    // Z-switch: MIDDLE = frozen, UP = mutatable. Long DOWN holds to save.
    void HandlePanelGestures()
    {
        int s = SwitchVal();
        int8_t sp = (s == Switch::Down) ? 0 : (s == Switch::Up) ? 2 : 1;
        snapshot_.switch_pos = sp;
        if (sp == 0)
        {
            if (prev_switch_ != 0) down_t0_us_ = time_us_32();
            uint32_t held = time_us_32() - down_t0_us_;
            // Past the tap window, a sustained DOWN arms a save: LEDs ramp up over ~5 s; full ramp commits.
            if (held >= kSaveHoldUs)      { save_ramp_ = VMAX; flash_op_req_ = 1; }
            else if (held >= kPageTapUs)
            {
                uint16_t b = (uint16_t)(((uint64_t)(held - kPageTapUs) * VMAX) / (kSaveHoldUs - kPageTapUs));
                save_ramp_ = b ? b : 1;
            }
        }
        else
        {
            if (save_ramp_)
            {
                save_ramp_ = 0;   // released mid-ramp: abort
            }
        }
        prev_switch_ = sp;
    }

    // One SnapshotView over the live members: encode reads through it, decode writes through it.
    SnapshotView MakeBlobView()
    {
        SnapshotView v{};
        v.control      = live_;
        v.tapes        = tapes_;
        v.master_main  = &master_main_;
        v.master_x     = &master_x_;
        v.master_y     = &master_y_;
        v.graph        = &graph_;
        v.term         = &term_;
        return v;
    }

    // Flash op (1 = save, 2 = factory-erase) then reboot. CORE 0 ONLY: erase disables XIP for
    // 50-100 ms and blocks the audio interrupt, so Core 1 is reset first (it runs from flash)
    // and we always reboot after.
    void DoFlashOpAndReboot(uint8_t op)
    {
        if (op == 1)
        {
            // A WRITE_STATE may have staged a patch that hasn't applied yet; apply first so we
            // persist the patch as authored, not the previous one.
            if (pending_apply_) ApplyPendingState();

            // Persist the patch AS LOADED (loaded_snapshot_), not a re-encode of live state: a
            // restart brings the patch up exactly as if just loaded. Layout: [u32 length][snapshot].
            memset(save_page_, 0, sizeof(save_page_));
            uint32_t snapshot_len = (uint32_t)loaded_snapshot_len_;
            memcpy(save_page_ + 4, loaded_snapshot_, snapshot_len);
            memcpy(save_page_, &snapshot_len, 4);

            multicore_reset_core1();
            uint32_t ints = save_and_disable_interrupts();
            flash_range_erase(kSaveOffset, kSavePageBytes);
            flash_range_program(kSaveOffset, save_page_, kSavePageBytes);
            restore_interrupts(ints);
        }
        else           // FACTORY RESET
        {
            multicore_reset_core1();
            uint32_t ints = save_and_disable_interrupts();
            flash_range_erase(kSaveOffset, kSavePageBytes);
            restore_interrupts(ints);
        }
        watchdog_reboot(0, 0, 0);
        while (1) {}
    }

    // Public request setter for the SysEx layer (Core 1). The actual write happens
    // on Core 0 in ProcessSample so only one core ever erases.
    void RequestFlashOp(uint8_t op) { flash_op_req_ = op; }

private:
    // live_ is STATIC (.bss): at 128 KB it must not live on main()'s stack (silent overflow).
    static uint8_t live_[kBufferBytes];
    uint8_t played_[kControlBytes];         // retroactive-freeze mirror (control region only)
    Tape    tapes_[kMaxTapes];
    int     tape_count_;

    // ONE graph + ONE terminal map for the whole card.
    Graph      graph_;
    Terminals  term_;
    ExprState  graph_state_;
    RecGate    rec_gate_[kMaxRecordheads] = {};
    int8_t     prev_switch_ = 1;
    uint32_t   down_t0_us_ = 0;
    uint16_t   save_ramp_ = 0;
    // Cross-core flash request: set by save gesture (Core 0) or SysEx (Core 1); SERVICED on Core 0.
    volatile uint8_t flash_op_req_ = 0;
    uint8_t save_page_[kSavePageBytes];          // scratch page for DoFlashOpAndReboot (called once per lifetime)

    Schedule   schedule_;
    static constexpr int kIoTasks = 3;
    int        io_turn_       = 0;
    int        led_turn_      = 0;
    static constexpr int kDanceSamples = 72000;   // ~1.5 s patch-load LED sweep
    int        boot_dance_    = 0;
    int16_t    last_audio_[2] = {0, 0};
    static constexpr int32_t kApplyQuiet   = 64;    // |audio| below this counts as a zero crossing
    static constexpr int32_t kApplyTimeout = 2400;  // ~50 ms: apply anyway if never quiet
    int32_t    pending_wait_ = 0;

    InputSnapshot snapshot_;

    // Fixed reference for envelope/slew decay maps and pulse width. Never recomputed.
    int32_t  spb_ = 12000;

    int32_t  out_note_[kNumOutputs];
    int32_t  out_cv_[kNumOutputs];
    int32_t  out_pulse_[kNumOutputs];
    uint8_t  pulse_high_[kNumOutputs];

    int32_t master_main_ = kDefaultMasterXStored;
    int32_t master_x_    = kDefaultMasterXStored;
    int32_t master_y_    = 0;       // boot in UNISON (no drift)

    // Soft-pickup runtime (NOT saved).
    int32_t master_main_snapshot_ = 0, master_x_snapshot_ = 0, master_y_snapshot_ = 0;
    bool    master_main_active_   = false, master_x_active_ = false, master_y_active_ = false;
    int32_t cur_phys_main_ = 0, cur_phys_x_ = 0, cur_phys_y_ = 0;
    bool    pickup_armed_  = false;
    int     boot_settle_   = kBootSettleSnaps;

    // Perf probe. Single writer (Core 0); Core 1 reads over SysEx (READ_PERF). Torn read is harmless.
    static constexpr int kPerfBlock = 4800;      // 0.1 s of musical time
    static constexpr int kPerfSections = 4;      // sched / jacks / rec / io
    uint32_t perf_sum_[kPerfSections] = {};
    uint32_t perf_max_[kPerfSections] = {};
    uint32_t perf_tsum_ = 0, perf_tmax_ = 0;
    uint32_t perf_n_ = 0;
    uint32_t perf_block_t0_us_ = 0;
    uint32_t perf_core1_t0_ = 0;
    uint32_t perf_samples_ = 0;
    uint32_t perf_late_ = 0;                     // Core 1 slices not landed by commit time (block)
    uint32_t perf_db_full_ = 0;                  // doorbells skipped, FIFO full (block)
    struct PerfBlockPub                          // wire layout mirrored in cli.js
    {
        uint32_t sysclk_hz;
        uint32_t samples;
        uint32_t block_us;
        uint32_t core1_loops;
        uint16_t count, must, stride;
        uint32_t avg[kPerfSections], max[kPerfSections];
        uint32_t total_avg, total_max;
        uint32_t late, db_full;
    } perf_pub_ = {};

    // Dual-core audio partition. Core 0 rebuilds ctx0_ at apply; only audio_in changes per sample.
    Context  ctx0_;
    // Cross-core handshake: Core 0 publishes ctx0_ + bumps db_seq_; Core 1 IRQ
    // recomputes its share + writes done; Core 0 commits when done == seq.
    struct Core1Handshake {
        volatile uint32_t done;        // Core 1 writes
        uint32_t          committed;   // Core 0 writes
        uint32_t          prev_seq;    // Core 0 writes (last seq Core 1 served)
        uint32_t          db_seq;      // Core 0 writes (current doorbell seq)
    } c1_ = {};

    // Ring Core 1's SIO FIFO doorbell with the current sequence number.
    inline void FireDoorbell()
    {
        if (multicore_fifo_wready()) sio_hw->fifo_wr = ++c1_.db_seq;
        else ++perf_db_full_;
    }

    // Commit Core 1's freshest completed slice (one-sample pipeline). Counts late if nothing new.
    inline void CommitCore1Slice()
    {
        const uint32_t done = c1_.done;
        if (done != c1_.committed) { CommitMust(schedule_, 1); c1_.committed = done; }
        else if (schedule_.must > 0) ++perf_late_;
    }

    inline void PerfPublish()
    {
        const uint32_t now_us = time_us_32();
        const uint32_t c1     = g_core1_loops;
        perf_pub_.samples     = perf_samples_;
        perf_pub_.block_us    = now_us - perf_block_t0_us_;
        perf_pub_.core1_loops = c1 - perf_core1_t0_;
        perf_pub_.count  = (uint16_t)schedule_.count;
        perf_pub_.must   = (uint16_t)schedule_.must;
        perf_pub_.stride = (uint16_t)schedule_.stride;
        for (int s = 0; s < kPerfSections; ++s)
        {
            perf_pub_.avg[s] = perf_sum_[s] / kPerfBlock;
            perf_pub_.max[s] = perf_max_[s];
            perf_sum_[s] = perf_max_[s] = 0;
        }
        perf_pub_.total_avg = perf_tsum_ / kPerfBlock;
        perf_pub_.total_max = perf_tmax_;
        perf_pub_.late      = perf_late_;
        perf_pub_.db_full   = perf_db_full_;
        perf_tsum_ = perf_tmax_ = 0;
        perf_late_ = perf_db_full_ = 0;
        perf_n_ = 0;
        perf_block_t0_us_ = now_us;
        perf_core1_t0_    = c1;
    }


    // ONE pool of NodeState slots, bound across the graph's used prefix at apply.
    NodeState form_pool_[kNodePool];

    uint32_t pitch_table_[128];             // MIDI note -> oscillator phase inc
    uint32_t rate_table_[256];              // byte -> phasor phase inc, log freq (phasor :rate)
    uint32_t ratio_table_[256];             // byte -> Q16 frequency RATIO, log, centred (follow :rate)

    // Patch apply handoff. Core 1 fills + sets pending_apply_; Core 0 decodes on the next quiet sample.
    volatile bool  pending_apply_;
    uint8_t        pending_snapshot_[LENS_MAX_SNAPSHOT];
    size_t         pending_len_ = 0;
    // Source bytes of the current patch. SAVE persists these so restart reloads as authored.
    uint8_t        loaded_snapshot_[LENS_MAX_SNAPSHOT];
    size_t         loaded_snapshot_len_ = 0;

    int32_t  active_page_;
    uint32_t rng_state_;

    Context __not_in_flash_func(MakeContext)()
    {
        return Context{ live_, tapes_, &snapshot_, spb_, pitch_table_, rate_table_, ratio_table_, { AudioIn1(), AudioIn2() } };
    }


    // Build the ONE global schedule from the ONE graph, sorted by interval (audio first), primed.
    void BuildSchedule()
    {
        schedule_.count = 0;
        SchedAdd(schedule_, &graph_state_, &graph_);
        SchedSort(schedule_);
        SchedPrime(schedule_);
    }




    // Bind graph_state_ across the used prefix of the pool, then (re)build the schedule.
    // Call AFTER the graph is set and BEFORE any state is evaluated.
    void RebindExprStates()
    {
        int len = graph_.length;
        if (len < 0) len = 0; else if (len > kNodePool) len = kNodePool;
        graph_state_.nodes = form_pool_;
        graph_state_.cap   = (uint16_t)len;
        ResetExprState(graph_state_);
        memset(rec_gate_, 0, sizeof rec_gate_);
        BuildSchedule();
    }

    // Measure each must-run slot's Recompute cost, then split the prefix so each core gets a fair
    // share (Core 0 minus its fixed per-sample overhead). Runs once per patch apply, off the hot path.
    static constexpr uint32_t kCore0FixedCycles = 2000;   // probe-informed; tune with cli.js perf
    void BalancePartition()
    {
        const int n = schedule_.must;
        if (n <= 0) return;
        Context ctx = MakeContext();
        static uint32_t cost[kNodePool];
        uint32_t total = 0;
        for (int k = 0; k < n; ++k)
        {
            RunSlot(schedule_.slot[k], ctx);                       // warm pass
            const uint32_t t0 = systick_hw->cvr;
            RunSlot(schedule_.slot[k], ctx);
            cost[k] = (t0 - systick_hw->cvr) & 0xFFFFFF;
            total += cost[k];
        }
        const uint32_t target = (total + kCore0FixedCycles) / 2;
        uint32_t c0 = kCore0FixedCycles;
        for (int k = 0; k < n; ++k)
        {
            const bool to_core0 = (c0 + cost[k] / 2) < target;
            schedule_.slot[k].core = to_core0 ? 0 : 1;
            if (to_core0) c0 += cost[k];
        }
        // Pin recordhead clock sources to Core 0. WriteRecordheads runs on Core 0 every
        // sample and reads `.phase`/`.wraps` from each recordhead's clock_from directly
        // (not the shadowed `.value`), so the clock source must not be writing on Core 1
        // while we read.
        static int16_t node_to_slot[kNodePool];
        for (int i = 0; i < kNodePool; ++i) node_to_slot[i] = -1;
        for (int k = 0; k < n; ++k) node_to_slot[schedule_.slot[k].node] = (int16_t)k;
        for (int r = 0; r < term_.rec_count; ++r)
        {
            const int16_t rt = term_.rec[r];
            if (rt < 0) continue;
            const int16_t cf = graph_.nodes[rt].clock_from;
            if (cf < 0) continue;
            const int ks = node_to_slot[cf];
            if (ks >= 0) schedule_.slot[ks].core = 0;
        }
        // Co-locate dependent pairs. Ops that read another node's intra-sample
        // `.phase`/`.level` (declared via CoLocateTarget) must execute on the same core
        // and AFTER the source in slot order. Slot order is already correct (the source
        // node has the lower index); only the core needs fixing up.
        for (int k = 0; k < n; ++k)
        {
            const Node& f = schedule_.slot[k].e->nodes[schedule_.slot[k].node];
            const int16_t src = CoLocateTarget(f);
            if (src < 0) continue;
            const int kin = node_to_slot[src];
            if (kin < 0) continue;                               // src is in the control suffix (rare)
            schedule_.slot[k].core = schedule_.slot[kin].core;
        }
        RebuildCorePartition(schedule_);
    }

    // Reset volatile runtime to a clean boot. Filled afterwards by ApplySnapshot.
    void ZeroRuntime()
    {
        memset(live_, 0, kBufferBytes);
        memset(played_, 0, kControlBytes);
        for (int i = 0; i < kMaxTapes; ++i) tapes_[i] = Tape{};
    }

    // THE apply path: SysEx WRITE, flash load, and boot default all land here. Core 0, top of sample.
    bool ApplySnapshot(const uint8_t* buf, size_t len)
    {
        // Remember audio-tape geometry so a live swap can keep ringing tails (below).
        struct { uint32_t start, length, clock_div; } oldgeo[kMaxTapes];
        const int old_count = tape_count_;
        for (int t = 0; t < kMaxTapes; ++t)
            oldgeo[t] = { tapes_[t].start, tapes_[t].length, tapes_[t].clock_div };

        SnapshotView v = MakeBlobView();
        SnapshotReader r(buf, len);
        if (!snapshot_decode(r, v, kSaveVersion)) return false;

        // Keep source bytes verbatim so SAVE persists the patch as authored, not runtime-evolved live_.
        if (len <= sizeof(loaded_snapshot_)) { memcpy(loaded_snapshot_, buf, len); loaded_snapshot_len_ = len; }

        // Only clear the audio region when tape geometry changed: same geometry = delay tails ring
        // through the swap, skipping the 128 KB memset removes most of the apply cost.
        bool geo_same = (old_count == v.tape_count);
        for (int t = 0; geo_same && t < kMaxTapes; ++t) {
            const bool was_audio = oldgeo[t].clock_div > 0, is_audio = tapes_[t].clock_div > 0;
            if (was_audio != is_audio) geo_same = false;
            else if (is_audio && (oldgeo[t].start != tapes_[t].start || oldgeo[t].length != tapes_[t].length
                                  || oldgeo[t].clock_div != tapes_[t].clock_div)) geo_same = false;
        }
        if (!geo_same) memset(live_ + kControlBytes, 0, (size_t)(kBufferBytes - kControlBytes));

        tape_count_  = v.tape_count;
        active_page_ = v.active_page;

        for (int j = 0; j < kNumOutputs; ++j)
        { out_note_[j] = 0; out_cv_[j] = 0; out_pulse_[j] = 0; pulse_high_[j] = 0; }

        RebindExprStates();
        pickup_armed_ = false;
        ctx0_ = MakeContext();
        SettleStaticChains();
        BalancePartition();
        boot_dance_ = kDanceSamples;
        return true;
    }

    // Boot: apply saved patch from flash if present + valid, else baked factory default.
    void InitDefaults()
    {
        ZeroRuntime();
        const uint8_t* flash = (const uint8_t*)(XIP_BASE + kSaveOffset);
        uint32_t flash_len;
        memcpy(&flash_len, flash, sizeof(flash_len));
        if (flash_len > 0 && flash_len <= LENS_MAX_SNAPSHOT &&
            snapshot_validate(flash + 4, flash_len, kSaveVersion) &&
            ApplySnapshot(flash + 4, flash_len))
            return;
        ZeroRuntime();
        ApplySnapshot(kDefaultSnapshot, kDefaultSnapshotLen);
    }

    // Run the cursor a few times before the first real sample so static chains (consts, clock
    // rates) settle through the shadow rather than appearing as a boot transient.
    void SettleStaticChains()
    {
        Context ctx = MakeContext();
        int hops = graph_.length > 0 ? graph_.length : 1;
        for (int k = 0; k < hops; ++k) RunSchedule(schedule_, ctx, kNodePool);
    }

    void ApplyPendingState()
    {
        pending_apply_ = false;
        ApplySnapshot(pending_snapshot_, pending_len_);
    }

    // MIDI note -> 48 kHz phase increment, one octave from C2 (MIDI 36).
    void BuildPitchTable()
    {
        static const uint32_t base_octave[12] = {
            5852657u, 6201218u, 6568220u, 6958385u, 7373140u, 7811611u,
            8275923u, 8768842u, 9290824u, 9842622u, 10428058u, 11048190u
        };
        for (int n = 0; n < 128; ++n)
        {
            int rel = n - 36, oct = rel / 12, rem = rel - oct * 12;
            if (rem < 0) { rem += 12; oct -= 1; }
            uint32_t base = base_octave[rem];
            if (oct >= 0) { if (oct > 16) oct = 16; pitch_table_[n] = base << oct; }
            else          { int s = -oct; if (s > 16) s = 16; pitch_table_[n] = base >> s; }
        }
    }

    // byte 0..255 -> phasor phase increment, LOG-spaced over [0.05 Hz .. 20 kHz]. inc = f * 2^32/SR.
    void BuildRateTable()
    {
        const double lo = 0.05, hi = 20000.0, k = 4294967296.0 / 48000.0;
        for (int b = 0; b < 256; ++b)
            rate_table_[b] = (uint32_t)(lo * pow(hi / lo, b / 255.0) * k + 0.5);
    }


    // byte 0..255 -> Q16 frequency RATIO, log, CENTRED: 2^((b-128)/128) so b=128 -> 1.0x (locked).
    // The follow :rate map; pow() at construction only, never in audio.
    void BuildRatioTable()
    {
        for (int b = 0; b < 256; ++b)
            ratio_table_[b] = (uint32_t)(pow(2.0, (b - 128) / 128.0) * 65536.0 + 0.5);
    }

    // CV in 1 -> oscillator phase inc, or a fixed C2 drone when unpatched.
    inline uint32_t WavePhaseIncCV1()
    {
        if (!Connected(Input::CV1)) return kWaveBasePhaseInc;
        int32_t semitone = (CVIn1() * 2304) >> 16;          // ~ cv * 12 / 341
        int32_t midi = kPitchInBaseNote + semitone;
        if (midi < 0) midi = 0; else if (midi > 127) midi = 127;
        return pitch_table_[midi];
    }

public:
    // Bridge methods — called only via the lens_state.h C shims.
    bool ApplyPending() const { return pending_apply_; }   // Core 1's busy probe (lens_state_busy)

    // Encode the live patch into buf. Returns snapshot length, or 0 if it would not fit.
    size_t Snapshot(uint8_t* buf, size_t cap)
    {
        SnapshotView v = MakeBlobView();
        int clen = kControlBytes;
        while (clen > 0 && live_[clen - 1] == 0) --clen;
        v.control_len = (uint16_t)clen;
        v.tape_count  = (uint8_t)tape_count_;
        v.active_page = (uint8_t)active_page_;
        SnapshotWriter w(buf, cap);
        snapshot_encode(w, v, kSaveVersion);
        return w.ok ? w.written(buf) : 0;
    }

    // Copy a validated snapshot into the pending buffer for apply on the next beat.
    bool StageSnapshot(const uint8_t* buf, size_t len)
    {
        if (len == 0 || len > LENS_MAX_SNAPSHOT)        return false;
        if (!snapshot_validate(buf, len, kSaveVersion)) return false;
        memcpy(pending_snapshot_, buf, len);
        pending_len_   = len;
        pending_apply_ = true;
        return true;
    }

    // Serialize the published perf block, field-by-field little-endian. Returns bytes written, 0 if cap too small.
    size_t PerfRead(uint8_t* buf, size_t cap) const
    {
        const size_t need = 2 + 3 * 2 + (4 + 2 * kPerfSections + 4) * 4;
        if (cap < need) return 0;
        size_t o = 0;
        auto w16 = [&](uint16_t v) { buf[o++] = v & 0xFF; buf[o++] = (v >> 8) & 0xFF; };
        auto w32 = [&](uint32_t v) { for (int k = 0; k < 4; ++k) buf[o++] = (v >> (8 * k)) & 0xFF; };
        buf[o++] = 2;                            // probe layout version
        buf[o++] = kPerfSections;
        w16(perf_pub_.count); w16(perf_pub_.must); w16(perf_pub_.stride);
        w32(perf_pub_.sysclk_hz); w32(perf_pub_.samples);
        w32(perf_pub_.block_us);  w32(perf_pub_.core1_loops);
        for (int s = 0; s < kPerfSections; ++s) { w32(perf_pub_.avg[s]); w32(perf_pub_.max[s]); }
        w32(perf_pub_.total_avg); w32(perf_pub_.total_max);
        w32(perf_pub_.late); w32(perf_pub_.db_full);
        return o;
    }

    // Core 1's half of the audio prefix: SIO FIFO doorbell IRQ lands here. RAM-pinned.
    void __not_in_flash_func(Core1Slice)(uint32_t seq)
    {
        Context ctx = ctx0_;
        // Catch-up: if the previous slice outlasted a sample, this recompute STANDS FOR the missed
        // samples (integrators advance by the full delta). Clamped: a huge delta is a transient.
        int32_t d = (int32_t)(seq - c1_.prev_seq);
        c1_.prev_seq = seq;
        ctx.catch_up_steps = (d < 1) ? 1 : (d > 4) ? 4 : d;
        RunMust(schedule_, ctx, 1);
        c1_.done = seq;
    }
};

uint8_t Lens::live_[kBufferBytes];

static Lens* g_lens = nullptr;

extern "C" {

const uint32_t kLensPersistedMagic   = kSaveMagic;
const uint32_t kLensPersistedVersion = kSaveVersion;

// Core 1 (SysEx) reads/writes the live patch through these.
size_t lens_state_snapshot(uint8_t* buf, size_t cap)
{
    return g_lens ? g_lens->Snapshot(buf, cap) : 0;
}

bool lens_state_stage(const uint8_t* buf, size_t len)
{
    return g_lens ? g_lens->StageSnapshot(buf, len) : false;
}

bool lens_state_busy(void)
{
    return g_lens ? g_lens->ApplyPending() : false;
}

size_t lens_perf_read(uint8_t* buf, size_t cap)
{
    return g_lens ? g_lens->PerfRead(buf, cap) : 0;
}

void lens_core1_slice(uint32_t seq)
{
    if (g_lens) g_lens->Core1Slice(seq);
}

// Called on Core 1: flash writes must run on Core 0 with Core 1 reset, so just request the op.
void lens_state_request_save(void)
{
    if (g_lens) g_lens->RequestFlashOp(1);
}

void lens_state_factory_reset(void)
{
    if (g_lens) g_lens->RequestFlashOp(2);
}

}  // extern "C"

int main()
{
    // 48 kHz audio rate is ADC-clocked off the 48 MHz USB PLL, independent of sys_clk: a higher
    // core clock is pure extra CPU per sample. clk_peri is re-parented to the USB PLL by
    // set_sys_clock_khz, so the MCP4822 DAC SPI is also safe.
    //
    // The regulator must be raised by HAND (the SDK auto-raise only runs in runtime_init_clocks,
    // a path we don't take). 250 MHz @ 1.15 V matches what arduino-pico ships; flash QSPI is
    // held to sysclk/4 by the boot2 override in CMakeLists.txt.
    vreg_set_voltage(VREG_VOLTAGE_1_15);
    sleep_ms(1);                              // let the regulator settle before the PLL jump
    set_sys_clock_khz(250000, true);

    // static (.bss, not stack): a Lens local would silently overflow the small core-0 stack.
    static Lens lens;
    lens.EnableNormalisationProbe();
    g_lens = &lens;

    // board_init only here; tud_init runs INSIDE core1_entry so the USB IRQ lands on Core 1's
    // NVIC. Core 0 never touches TinyUSB. Audio interrupt requires pico_enable_stdio_usb(0).
    board_init();
    multicore_launch_core1(core1_entry);

    lens.Run();
}
