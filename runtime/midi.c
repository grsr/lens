/* midi.c -- MIDI channel-voice parser; single writer of midi_scratch[].
 * No USB/TinyUSB dependencies; call midi_feed_byte once per incoming byte.
 * int32_t writes are atomic on M0+; no latch needed (one-sample skew is fine). */

#include "midi.h"
#include <string.h>

/* Cross-core ordering for the MIDI-out ring: Core 0 fills a slot then advances
   head; Core 1 reads head then the slot. M0+ needs a real DMB between, not just a
   compiler barrier. The host sim is single-threaded, so a compiler barrier suffices. */
#if defined(__arm__) || defined(__thumb__)
  #define MIDI_BARRIER() __asm__ volatile ("dmb" ::: "memory")
#else
  #define MIDI_BARRIER() __asm__ volatile ("" ::: "memory")
#endif

static int32_t midi_scratch[MIDI_SCRATCH_SIZE];

/* ---- Note stack (last-note priority, per channel) ---- */
#define NOTE_STACK_DEPTH 8

typedef struct {
    uint8_t notes[NOTE_STACK_DEPTH];
    uint8_t count;
} NoteStack;

static NoteStack note_stacks[16];  /* index 0 = MIDI channel 1 */

/* Per-note hold count across all channels (drives HELD region). */
static uint8_t held_count[128];

/* ---- Parser state ---- */
static uint8_t running_status;
static uint8_t in_sysex;
static uint8_t data_buf[2];
static uint8_t data_count;
static uint8_t expected_data;

/* ---- Helpers ---- */

static int status_data_len(uint8_t status) {
    uint8_t type = status & 0xF0;
    if (type == 0x80) return 2;  /* note-off */
    if (type == 0x90) return 2;  /* note-on */
    if (type == 0xB0) return 2;  /* control change */
    if (type == 0xD0) return 1;  /* channel pressure (aftertouch) */
    if (type == 0xE0) return 2;  /* pitch bend */
    return 0;
}

/* Transport + clock state (MIDI system realtime, no channel). */
static uint8_t clock_phase;   /* 0..MIDI_CLOCK_PPQ-1, advances on 0xF8 */
static uint8_t transport_on;  /* 1 between Start/Continue and Stop */

/* Update NOTE/GATE for a channel (and the omni slot). NOTE HOLDS the last note
   (so a pitch CV stays put between notes, the way a MIDI->CV converter behaves);
   GATE tracks key-down. NOTE only changes while a key is held; on release it is
   left untouched. */
static void update_note_gate(uint8_t ch) {
    if (note_stacks[ch].count > 0)
        midi_scratch[NOTE_BASE + ch + 1] = note_stacks[ch].notes[note_stacks[ch].count - 1];
    midi_scratch[GATE_BASE + ch + 1] = (note_stacks[ch].count > 0) ? 4095 : 0;

    int any_down = 0;
    for (int c = 0; c < 16; c++) {
        if (note_stacks[c].count > 0) {
            any_down = 1;
            midi_scratch[NOTE_BASE] = note_stacks[c].notes[note_stacks[c].count - 1];
        }
    }
    midi_scratch[GATE_BASE] = any_down ? 4095 : 0;
}

static void do_note_off(uint8_t ch, uint8_t note) {
    NoteStack* st = &note_stacks[ch];
    for (int i = 0; i < (int)st->count; i++) {
        if (st->notes[i] == note) {
            for (int j = i; j < (int)st->count - 1; j++)
                st->notes[j] = st->notes[j + 1];
            st->count--;
            break;
        }
    }
    if (held_count[note] > 0) {
        held_count[note]--;
        if (held_count[note] == 0)
            midi_scratch[HELD_BASE + note] = 0;
    }
    update_note_gate(ch);
}

static void do_note_on(uint8_t ch, uint8_t note, uint8_t vel) {
    if (vel == 0) { do_note_off(ch, note); return; }

    NoteStack* st = &note_stacks[ch];

    /* Remove if already present (re-push to top for last-note priority). */
    for (int i = 0; i < (int)st->count; i++) {
        if (st->notes[i] == note) {
            for (int j = i; j < (int)st->count - 1; j++)
                st->notes[j] = st->notes[j + 1];
            st->count--;
            break;
        }
    }
    /* Drop oldest on overflow. */
    if (st->count == NOTE_STACK_DEPTH) {
        for (int i = 0; i < NOTE_STACK_DEPTH - 1; i++)
            st->notes[i] = st->notes[i + 1];
        st->count = NOTE_STACK_DEPTH - 1;
    }
    st->notes[st->count++] = note;

    if (held_count[note] < 255) held_count[note]++;
    midi_scratch[HELD_BASE + note] = 4095;

    /* Velocity latches per channel + omni (0..127 -> 0..4095). */
    int32_t vel12 = ((int32_t)vel * 4095) / 127;
    midi_scratch[VEL_BASE + ch + 1] = vel12;
    midi_scratch[VEL_BASE]          = vel12;

    update_note_gate(ch);
}

static void do_control_change(uint8_t ccnum, uint8_t val) {
    /* 0..127 -> 0..4095; 32-bit integer only. */
    midi_scratch[CC_BASE + ccnum] = ((int32_t)val * 4095) / 127;
}

static void do_pitch_bend(uint8_t ch, uint8_t lsb, uint8_t msb) {
    /* 14-bit (centre 8192) -> 12-bit (centre 2048): raw >> 2. */
    int32_t raw14 = ((int32_t)msb << 7) | (int32_t)lsb;
    int32_t bend12 = raw14 >> 2;
    midi_scratch[BEND_BASE + ch + 1] = bend12;
    midi_scratch[BEND_BASE]          = bend12;
}

static void do_channel_pressure(uint8_t ch, uint8_t val) {
    /* Aftertouch 0..127 -> 0..4095 (per channel + omni). */
    int32_t p12 = ((int32_t)val * 4095) / 127;
    midi_scratch[PRESS_BASE + ch + 1] = p12;
    midi_scratch[PRESS_BASE]          = p12;
}

/* MIDI clock: publish a 12-bit beat phasor that wraps once per quarter note.
   Falling edge (wrap) = the downbeat, so (trig (midi-clock)) ticks per beat. */
static void publish_clock(void) {
    midi_scratch[CLOCK_BASE] = ((int32_t)clock_phase * 4096) / MIDI_CLOCK_PPQ;
}
static void do_clock_tick(void) {
    if (++clock_phase >= MIDI_CLOCK_PPQ) clock_phase = 0;
    publish_clock();
}
static void do_transport(uint8_t on, uint8_t reset) {
    transport_on = on;
    if (reset) { clock_phase = 0; publish_clock(); }  /* Start = downbeat */
    midi_scratch[PLAY_BASE] = on ? 4095 : 0;
}

static void dispatch(uint8_t status, uint8_t d0, uint8_t d1) {
    uint8_t type = status & 0xF0;
    uint8_t ch   = status & 0x0F;
    if (type == 0x90) { do_note_on(ch, d0, d1);       return; }
    if (type == 0x80) { do_note_off(ch, d0);           return; }
    if (type == 0xB0) { do_control_change(d0, d1);    return; }
    if (type == 0xD0) { do_channel_pressure(ch, d0); return; }
    if (type == 0xE0) { do_pitch_bend(ch, d0, d1);    return; }
}

/* ---- Public API ---- */

void midi_reset(void) {
    memset(midi_scratch, 0, sizeof(midi_scratch));
    memset(note_stacks,  0, sizeof(note_stacks));
    memset(held_count,   0, sizeof(held_count));
    /* Pitch bend rests at centre, not zero. */
    for (int i = 0; i <= 16; i++) midi_scratch[BEND_BASE + i] = MIDI_BEND_CENTRE;
    clock_phase    = 0;
    transport_on   = 0;
    running_status = 0;
    in_sysex       = 0;
    data_count     = 0;
    expected_data  = 0;
}

void midi_feed_byte(uint8_t b) {
    /* System realtime (0xF8..0xFF): may interleave mid-message, so handle and
       return WITHOUT touching running status. Clock + transport are consumed
       here; the rest are ignored. */
    if (b >= 0xF8) {
        if      (b == 0xF8) do_clock_tick();           /* timing clock */
        else if (b == 0xFA) do_transport(1, 1);        /* start: play + downbeat */
        else if (b == 0xFB) do_transport(1, 0);        /* continue: play, keep phase */
        else if (b == 0xFC) do_transport(0, 0);        /* stop */
        return;
    }

    if (b == 0xF0) {
        in_sysex = 1; running_status = 0; data_count = 0; expected_data = 0;
        return;
    }
    if (b == 0xF7) { in_sysex = 0; return; }
    if (in_sysex)  return;

    /* Other system common (0xF1..0xF6): clear running status, ignore. */
    if (b >= 0xF0) {
        running_status = 0; data_count = 0; expected_data = 0;
        return;
    }

    /* Channel status byte. */
    if (b & 0x80) {
        running_status = b;
        data_count     = 0;
        expected_data  = (uint8_t)status_data_len(b);
        return;
    }

    /* Data byte: apply running status if no current status. */
    if (expected_data == 0) {
        if (running_status == 0) return;
        expected_data = (uint8_t)status_data_len(running_status);
        if (expected_data == 0) return;
        data_count = 0;
    }

    if (data_count < 2) data_buf[data_count++] = b;

    if (data_count == expected_data) {
        dispatch(running_status, data_buf[0], data_buf[1]);
        data_count = 0;  /* next data byte reuses running status */
    }
}

int32_t* runtime_midi_jack_ptr(uint32_t idx) {
    return &midi_scratch[idx < MIDI_SCRATCH_SIZE ? idx : MIDI_SCRATCH_SIZE - 1];
}

/* ---- MIDI output TX ring (SPSC lock-free) ---- */
/* Core 0 is sole producer; Core 1 is sole consumer.
 * Each slot holds up to 4 bytes; capacity 256 slots.
 * Overflow drops the newest message and bumps a counter. */

#define MIDI_OUT_RING_CAP 256u

typedef struct {
    uint8_t data[4];
    uint8_t len;
} MidiOutSlot;

static MidiOutSlot   midi_out_ring[MIDI_OUT_RING_CAP];
static volatile uint32_t midi_out_head = 0;  /* producer (Core 0) */
static volatile uint32_t midi_out_tail = 0;  /* consumer (Core 1) */
static uint32_t      midi_out_dropped  = 0;

void midi_out_push(const uint8_t* bytes, uint8_t len) {
    uint32_t h = midi_out_head;
    uint32_t t = midi_out_tail;
    if (h - t >= MIDI_OUT_RING_CAP) { midi_out_dropped++; return; }
    MidiOutSlot* slot = &midi_out_ring[h & (MIDI_OUT_RING_CAP - 1)];
    if (len > 4) len = 4;
    for (uint8_t i = 0; i < len; i++) slot->data[i] = bytes[i];
    slot->len = len;
    MIDI_BARRIER();   /* slot data visible before head advances */
    midi_out_head = h + 1;
}

uint8_t midi_out_pop(uint8_t* out) {
    uint32_t t = midi_out_tail;
    uint32_t h = midi_out_head;
    if (t == h) return 0;
    MidiOutSlot* slot = &midi_out_ring[t & (MIDI_OUT_RING_CAP - 1)];
    uint8_t len = slot->len;
    for (uint8_t i = 0; i < len; i++) out[i] = slot->data[i];
    MIDI_BARRIER();   /* slot read complete before tail advances */
    midi_out_tail = t + 1;
    return len;
}
