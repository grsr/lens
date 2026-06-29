#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* MIDI scratch buffer layout (int32_t, 12-bit values).
 * NOTE  base 0:   slots 0..16  (0=omni, 1..16=channel)
 * GATE  base 17:  slots 17..33
 * CC    base 34:  slots 34..161 (ccnum 0..127)
 * HELD  base 162: slots 162..289 (note 0..127)
 * VEL   base 290: slots 290..306 (per channel; velocity of last note-on, 0..4095)
 * BEND  base 307: slots 307..323 (per channel; 12-bit, centre 2048)
 * PRESS base 324: slots 324..340 (per channel; channel pressure 0..4095)
 * CLOCK base 341: 1 slot (beat phasor 0..4095, wraps once per quarter note, MIDI-synced)
 * PLAY  base 342: 1 slot (0/4095 transport gate: high between Start/Continue and Stop)
 * Layout is shared with compiler/lowerer.js -- keep both in sync. */
#define MIDI_SCRATCH_SIZE 343
#define NOTE_BASE  0
#define GATE_BASE  17
#define CC_BASE    34
#define HELD_BASE  162
#define VEL_BASE   290
#define BEND_BASE  307
#define PRESS_BASE 324
#define CLOCK_BASE 341
#define PLAY_BASE  342
#define MIDI_BEND_CENTRE 2048
#define MIDI_CLOCK_PPQ   24   /* MIDI clock ticks per quarter note */

/* Clear parser state and zero midi_scratch. */
void midi_reset(void);

/* Advance parser with one incoming byte; updates midi_scratch. */
void midi_feed_byte(uint8_t b);

/* Pointer into midi_scratch; clamps idx to valid range. */
int32_t* runtime_midi_jack_ptr(uint32_t idx);

/* MIDI output TX ring (SPSC, Core 0 produces, Core 1 consumes).
 * midi_out_push: called from Core 0 audio walk; drops on full.
 * midi_out_pop:  called from Core 1 device loop; returns bytes read (0 if empty). */
void    midi_out_push(const uint8_t* bytes, uint8_t len);
uint8_t midi_out_pop(uint8_t* out);

#ifdef __cplusplus
}
#endif
