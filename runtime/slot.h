#pragma once
#include <stdint.h>

/* Pull in __not_in_flash_func when compiling for RP2040 hardware so kernel
 * functions decorated with it are placed in RAM, not flash. */
#ifdef PICO_ON_DEVICE
#include "pico/platform/compiler.h"
#include "pico/platform/sections.h"
#define OP_FN(name) __not_in_flash_func(name)
#else
#define OP_FN(name) name
#endif

#define VMAX  4095
#define VMID  2048
#define VMIN  0

/* Rising-edge detector shared by edge / step / clock kernels. */
#define RISING(x, last)  ((x) > VMID && (last) <= VMID)

struct Slot;
typedef void (*SlotFn)(struct Slot*);

struct Slot {
    uint8_t  kernel_id;   /* KernelId enum; set by snapshot_apply */
    uint8_t  _pad[3];
    void* out;
    void* in0;
    void* in1;
    void* in2;
    void* in3;
    void* in4;
    uint32_t param0;      /* structural-only: mode/jack/port/mask/seed/flags */
    SlotFn   fn;          /* RAM-resident kernel fn; set at apply time */
};

#if defined(__arm__) || defined(__thumb__)
_Static_assert(sizeof(struct Slot) == 36, "Slot must be 36 bytes");
#endif

static inline int32_t slot_in0(const struct Slot* s) { return *(const int32_t*)s->in0; }
static inline int32_t slot_in1(const struct Slot* s) { return *(const int32_t*)s->in1; }
static inline int32_t slot_in2(const struct Slot* s) { return *(const int32_t*)s->in2; }
static inline int32_t slot_in3(const struct Slot* s) { return *(const int32_t*)s->in3; }
static inline int32_t slot_in4(const struct Slot* s) { return *(const int32_t*)s->in4; }
static inline void    slot_write(const struct Slot* s, int32_t v) { *(int32_t*)s->out = v; }
