#pragma once
/*
 * Lens snapshot wire format.
 * Little-endian throughout. All fields packed (no struct padding).
 * Produced by lens/snapshot.js encode(); consumed by ApplySnapshot() (session 6).
 *
 * Layout:
 *   HEADER          (16 bytes)
 *   KERNEL REGISTRY (variable)
 *   SLOT TABLE      (variable)
 *   BUFFER TABLE    (variable)
 *   TERMINAL TABLE  (variable)
 *   CRC32           (4 bytes)
 */

#include <stdint.h>

/* ---- Magic / version ---- */
#define LENS_MAGIC     { 0x4C, 0x45, 0x4E, 0x53, 0x32 } /* snapshot wire magic, 5 bytes */
#define LENS_MAGIC_LEN 5
#define LENS_VERSION   11
#define LENS_MAX_BYTES 8192

/* ---- HEADER (16 bytes, packed) ----
 *
 *   magic[5]          = LENS_MAGIC
 *   version           = u16 le
 *   flags             = u16 le  (reserved, write 0)
 *   slot_count        = u16 le  (all slots, in walk order)
 *   reserved          = u16 le  (write 0)
 *   reserved          = u16 le  (write 0)
 *   buffer_count      = u8
 *   terminal_count    = u8
 *   kernel_id_count   = u8
 *   reserved          = u8      (write 0)
 */
typedef struct {
    uint8_t  magic[5];
    uint16_t version;
    uint16_t flags;
    uint16_t slot_count;
    uint16_t reserved1;   /* write 0 */
    uint16_t reserved2;   /* write 0 */
    uint8_t  buffer_count;
    uint8_t  terminal_count;
    uint8_t  kernel_id_count;
    uint8_t  reserved;
} __attribute__((packed)) Lens2Header;

/* ---- KERNEL REGISTRY ----
 *
 * Follows immediately after the header.
 * For i in 0..kernel_id_count-1:
 *   name_len  = u8       (number of ASCII bytes that follow)
 *   name[name_len]       (e.g. "op_add")
 *
 * The decoder resolves each name to a function pointer at apply time.
 * Kernel id 0 is the first entry, id 1 the second, etc.
 */

/* ---- SLOT TABLE ----
 *
 * Follows kernel registry. Layout:
 *   slot_count slot records, in walk order.
 *
 * Per-slot record layout:
 *   kernel_id  = u8        (index into kernel registry)
 *   core       = u8        (0 or 1)
 *   in_count   = u8        (0..5)
 *   in_refs[in_count]:     (variable width; see LENS_TAG_* below)
 *   out_offset = u16 le    (byte offset in this core's NodeState pool)
 *   param0     = u32 le    (structural-only: mode/jack/port/mask/seed/flags)
 *
 * out_offset: sequential within each core's pool. Decoder computes the
 * pool base address per core and adds out_offset to get the write pointer.
 * in_refs of kind TAG_SLOT carry the walk-order index into the combined
 * (SR + all CR) slot array; apply resolves to the owning slot's out ptr.
 */

/* ---- in_ref tags ---- */
#define LENS_TAG_SLOT             0  /* u8 tag + u16 le slot_id (points at value field) */
#define LENS_TAG_BUFFER           1  /* u8 tag + u16 le buffer_id */
#define LENS_TAG_CONST_U8         2  /* u8 tag + u8  value (0..255) */
#define LENS_TAG_CONST_I32        3  /* u8 tag + i32 le value */
#define LENS_TAG_SLOT_OUT2        4  /* u8 tag + u16 le slot_id, points at producer's +4 second output (recordhead head_pos, phasor tick) */

/* ---- BUFFER TABLE ----
 *
 * Follows slot table. buffer_count entries:
 *   kind        = u8        (LENS_BUF_KIND_*)
 *   length      = u32 le    (cell count; audio buffers can exceed 65535)
 *   seed_present= u8        (0 or 1)
 *   if seed_present:
 *     cells[length] = u16 le each (12-bit values in 16-bit fields)
 *
 * Audio buffers never carry a seed (they start silent).
 * Tape and lens buffers carry a seed when authored with literals.
 */
#define LENS_BUF_KIND_TAPE  0
#define LENS_BUF_KIND_AUDIO 1
#define LENS_BUF_KIND_LENS  2

/* ---- TERMINAL TABLE ----
 *
 * Follows buffer table. terminal_count entries:
 *   jack_id  = u8     (LENS_JACK_*)
 *   slot_idx = u16 le (walk-order index of the source slot)
 *   mode     = u8     (0 = raw, 1 = v/oct pitch)
 */
#define LENS_JACK_AUDIO_OUT_1 0
#define LENS_JACK_AUDIO_OUT_2 1
#define LENS_JACK_CV_OUT_1    2
#define LENS_JACK_CV_OUT_2    3
#define LENS_JACK_PULSE_OUT_1 4
#define LENS_JACK_PULSE_OUT_2 5
#define LENS_JACK_LED_0       6
#define LENS_JACK_LED_1       7
#define LENS_JACK_LED_2       8
#define LENS_JACK_LED_3       9
#define LENS_JACK_LED_4       10
#define LENS_JACK_LED_5       11

/* ---- CRC-32 ----
 *
 * Final 4 bytes. IEEE 802.3 polynomial 0xEDB88320, little-endian.
 * Covers all bytes from magic[0] through the last terminal table byte.
 * Decoder verifies before applying; mismatch = reject.
 */
