#pragma once

#ifdef __cplusplus
extern "C" {
#endif

#define CFG_TUSB_OS                 OPT_OS_PICO
#define CFG_TUSB_MEM_SECTION
#define CFG_TUSB_MEM_ALIGN          __attribute__ ((aligned(4)))

#ifndef CFG_TUSB_DEBUG
#define CFG_TUSB_DEBUG              0
#endif

// Host + device stacks on RHPORT0; the role is chosen at boot. Role detection
// reads the USB-C CC pins on Core 0; Core 1 then calls tusb_init() (host) or
// tud_init(0) (device). Approach credited to Music Thing Workshop System
// 33_drumdrum (Workshop_Computer repo).
#define CFG_TUSB_RHPORT0_MODE       (OPT_MODE_HOST | OPT_MODE_DEVICE)
#define CFG_TUD_ENDPOINT0_SIZE      64
#define CFG_TUD_MIDI                1
#define CFG_TUD_CDC                 0
#define CFG_TUD_MSC                 0
#define CFG_TUD_HID                 0
#define CFG_TUD_VENDOR              0
// Sized to leave SRAM for the host stack alongside the 128 KB audio pool.
// Covers ~6 KB sysex patches in device role (factory + MIDI patches are 1-2 KB).
#define CFG_TUD_MIDI_RX_BUFSIZE     12288
#define CFG_TUD_MIDI_TX_BUFSIZE     2048
#define CFG_TUD_MIDI_EP_BUFSIZE     64
#define CFG_TUH_ENABLED             1
#define CFG_TUH_RPI_PIO_USB         0
// No hub: a keyboard plugs straight into the USB-C port. Saves SRAM alongside
// the 128 KB audio pool.
#define CFG_TUH_HUB                 0
#define CFG_TUH_DEVICE_MAX          1
#define CFG_TUH_ENUMERATION_BUFSIZE 256
// CFG_TUH_MIDI is intentionally unset: TinyUSB 0.18 (pico-sdk 2.1.1) has no MIDI
// host class, and CFG_TUH_MIDI=1 makes usbh.c reference AUDIO_SUBCLASS_CONTROL
// without including audio.h, which does not compile. The rppicomidi app driver
// needs no hint: midih_open() parses the descriptor itself and registers via
// usbh_app_driver_get_cb.

#ifdef __cplusplus
}
#endif
