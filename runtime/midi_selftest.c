/* midi_selftest.c -- include midi.c directly to access midi_scratch. */

#include <stdio.h>
#include <assert.h>
#include <stdint.h>
#include <string.h>

/* Stub memset/memcpy so midi.c compiles standalone without a libc. */
/* (Standard libc is present in the selftest build; no stub needed.) */

#include "midi.c"

int main(void) {
    /* Test 1: note-on ch1 note60 vel100. */
    midi_reset();
    midi_feed_byte(0x90); midi_feed_byte(0x3C); midi_feed_byte(0x64);
    assert(midi_scratch[NOTE_BASE + 1] == 60);
    assert(midi_scratch[GATE_BASE + 1] == 4095);
    assert(midi_scratch[GATE_BASE + 0] == 4095);  /* omni */
    assert(midi_scratch[HELD_BASE + 60] == 4095);

    /* Test 2: note-off. Gate + held clear, but NOTE HOLDS the last pitch. */
    midi_feed_byte(0x80); midi_feed_byte(0x3C); midi_feed_byte(0x00);
    assert(midi_scratch[GATE_BASE + 1] == 0);
    assert(midi_scratch[HELD_BASE + 60] == 0);
    assert(midi_scratch[NOTE_BASE + 1] == 60);   /* pitch holds between notes */
    assert(midi_scratch[NOTE_BASE + 0] == 60);   /* omni holds too */

    /* Test 3: CC1 = 127 -> 4095. */
    midi_reset();
    midi_feed_byte(0xB0); midi_feed_byte(0x01); midi_feed_byte(0x7F);
    assert(midi_scratch[CC_BASE + 1] == 4095);

    /* Test 4: running status -- second note-on via bare data bytes. */
    midi_reset();
    midi_feed_byte(0x90); midi_feed_byte(0x40); midi_feed_byte(0x7F);
    midi_feed_byte(0x42); midi_feed_byte(0x7F);  /* running status: note-on note66 */
    assert(midi_scratch[NOTE_BASE + 1] == 66);

    /* Test 5: channel 2 (0x91 = note-on ch2). */
    midi_reset();
    midi_feed_byte(0x91); midi_feed_byte(0x30); midi_feed_byte(0x40);
    assert(midi_scratch[NOTE_BASE + 2] == 48);

    /* Test 6: channel pressure (0xD0 ch1, value 64) -> 2063, omni + channel. */
    midi_reset();
    midi_feed_byte(0xD0); midi_feed_byte(0x40);
    assert(midi_scratch[PRESS_BASE + 1] == 2063);
    assert(midi_scratch[PRESS_BASE + 0] == 2063);

    /* Test 7: clock + transport. Start resets to downbeat and plays. */
    midi_reset();
    assert(midi_scratch[PLAY_BASE] == 0);
    midi_feed_byte(0xFA);                       /* Start */
    assert(midi_scratch[PLAY_BASE] == 4095);
    assert(midi_scratch[CLOCK_BASE] == 0);      /* downbeat */
    for (int i = 0; i < 12; i++) midi_feed_byte(0xF8);  /* half a beat */
    assert(midi_scratch[CLOCK_BASE] == (12 * 4096) / MIDI_CLOCK_PPQ);  /* = 2048 */
    for (int i = 0; i < 12; i++) midi_feed_byte(0xF8);  /* complete the beat -> wrap */
    assert(midi_scratch[CLOCK_BASE] == 0);      /* wrapped to downbeat */
    /* Interleaved clock must not corrupt a running note message. */
    midi_feed_byte(0x90); midi_feed_byte(0xF8); midi_feed_byte(0x45); midi_feed_byte(0x7F);
    assert(midi_scratch[NOTE_BASE + 1] == 69);  /* note 69 parsed despite the 0xF8 */
    midi_feed_byte(0xFC);                        /* Stop */
    assert(midi_scratch[PLAY_BASE] == 0);

    printf("MIDI SELFTEST PASS\n");
    return 0;
}
