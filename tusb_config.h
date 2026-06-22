#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// Device-only: USB MIDI SysEx to the browser configurator.
#define CFG_TUSB_RHPORT0_MODE       OPT_MODE_DEVICE
#define CFG_TUSB_OS                 OPT_OS_PICO
#define CFG_TUSB_MEM_SECTION
#define CFG_TUSB_MEM_ALIGN          __attribute__ ((aligned(4)))

#ifndef CFG_TUSB_DEBUG
#define CFG_TUSB_DEBUG              0
#endif

#define CFG_TUD_ENDPOINT0_SIZE      64
#define CFG_TUD_MIDI                1
#define CFG_TUD_CDC                 0
#define CFG_TUD_MSC                 0
#define CFG_TUD_HID                 0
#define CFG_TUD_VENDOR              0

// MIDI RX FIFO. Each 3 source bytes pack into 1 four-byte USB MIDI packet,
// so a SOURCE_CAP (8 KB) sysex payload becomes ~9.4 KB wire + headers,
// ~3144 packets, ~12.6 KB in the FIFO. 16 KB covers worst case with margin.
#define CFG_TUD_MIDI_RX_BUFSIZE     16384
#define CFG_TUD_MIDI_TX_BUFSIZE     2048
#define CFG_TUD_MIDI_EP_BUFSIZE     64

#ifdef __cplusplus
}
#endif
