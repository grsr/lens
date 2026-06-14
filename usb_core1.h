#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Core 1 entry: pumps TinyUSB device task and SysEx polling.
void core1_entry(void);

// Core 1 loop iterations since boot; sampled by Core 0's perf probe.
extern volatile uint32_t g_core1_loops;

#ifdef __cplusplus
}
#endif
