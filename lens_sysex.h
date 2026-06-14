#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// SysEx framing. Manufacturer ID 0x7D 0x4C 0x45 ("L" "E"). All messages:
//   F0 7D 4C 45 <cmd> <payload...> F7
// Snapshot payloads are 7-bit-packed "8-into-7" (7 raw bytes -> 8 MIDI bytes).
//
// Inbound (browser to card):
//   0x01 READ_STATE       payload empty.       Card replies with 0x10.
//   0x02 WRITE_STATE      payload packed snapshot. Card stages it for live apply.
//   0x03 SAVE_STATE       payload empty.       Card writes flash, reboots.
//   0x04 FACTORY_RESET    payload empty.       Card erases flash, reboots.
//   0x05 PING             payload empty.       Card replies with 0x7F ACK.
//   0x06 READ_PERF        payload empty.       Card replies with 0x11.
//
// Outbound (card to browser):
//   0x10 STATE_DUMP       payload: packed patch snapshot
//   0x11 PERF_DUMP        payload: packed perf-probe block (Lens::PerfRead layout)
//   0x7F ACK              payload: echoed cmd byte
//   0x7E NACK             payload: echoed cmd byte, reason byte
//
// NACK reasons:
//   0x01 unknown command
//   0x02 payload too short / too long
//   0x03 magic mismatch
//   0x04 version mismatch (card and editor disagree on layout)
//   0x05 internal buffer overrun

#define LENS_SYSEX_MFR_0   0x7D
#define LENS_SYSEX_MFR_1   0x4C   // 'L'
#define LENS_SYSEX_MFR_2   0x45   // 'E'

#define LENS_SYSEX_CMD_READ_STATE      0x01
#define LENS_SYSEX_CMD_WRITE_STATE     0x02
#define LENS_SYSEX_CMD_SAVE_STATE      0x03
#define LENS_SYSEX_CMD_FACTORY_RESET   0x04
#define LENS_SYSEX_CMD_PING            0x05
#define LENS_SYSEX_CMD_READ_PERF       0x06

#define LENS_SYSEX_CMD_STATE_DUMP      0x10
#define LENS_SYSEX_CMD_PERF_DUMP       0x11
#define LENS_SYSEX_CMD_ACK             0x7F
#define LENS_SYSEX_CMD_NACK            0x7E

#define LENS_SYSEX_NACK_UNKNOWN_CMD    0x01
#define LENS_SYSEX_NACK_BAD_LENGTH     0x02
#define LENS_SYSEX_NACK_BAD_MAGIC      0x03
#define LENS_SYSEX_NACK_BAD_VERSION    0x04
#define LENS_SYSEX_NACK_OVERRUN        0x05
#define LENS_SYSEX_NACK_BUSY           0x06   /* a staged patch is still waiting to apply; retry */

// Drain MIDI, dispatch SysEx, send pending replies. Called from Core 1's loop.
void lens_sysex_task(void);

#ifdef __cplusplus
}
#endif
