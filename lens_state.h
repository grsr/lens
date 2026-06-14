#pragma once

// C-callable bridge: Core 1 (SysEx) talks to live Lens on Core 0.

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Staging buffer caps. LENS_MAX_PACKED is 8-into-7 expansion plus framing slack.
#define LENS_MAX_SNAPSHOT    4096
#define LENS_MAX_PACKED  (LENS_MAX_SNAPSHOT + (LENS_MAX_SNAPSHOT / 7) + 8)

extern const uint32_t kLensPersistedMagic;
extern const uint32_t kLensPersistedVersion;

// Snapshot current state into buf. Returns length, or 0 if it would not fit.
size_t lens_state_snapshot(uint8_t* buf, size_t cap);

// Stage a received snapshot for live apply (Core 0 swaps in at quiet moment).
bool lens_state_stage(const uint8_t* buf, size_t len);

// True while a staged snapshot still waits to apply. SysEx layer NACKs WRITE in this window.
bool lens_state_busy(void);

// Latest perf-probe block (fixed LE layout; decoded by cli.js perf).
size_t lens_perf_read(uint8_t* buf, size_t cap);

// Core 1's audio slice. Called ONLY from the SIO FIFO IRQ on Core 1.
void lens_core1_slice(uint32_t seq);

// Write current RAM state to flash, then reboot. Never returns.
void lens_state_request_save(void);

// Erase the flash sector, then reboot to defaults. Never returns.
void lens_state_factory_reset(void);

#ifdef __cplusplus
}
#endif
