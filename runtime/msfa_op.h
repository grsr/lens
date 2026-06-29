#pragma once
#include <stdint.h>
#include "msfa_tables.h"
/* Per-sample port of Dexed/msfa FmOpKernel (attic/dx7ref/fm_op_kernel.cc).

   msfa runs the kernel in blocks of 64 with the operator gain interpolated
   across the block (dgain). Lens is per-sample: the gain arrives fresh from the
   envelope every sample, so dgain is 0 and the block reduces to one step:

       y   = Sin::lookup(phase + input);
       out = ((int64)y * gain) >> 24;     // gain is Q24 linear (Exp2 output)
       phase += freq;

   Everything is 32-bit. The one wide product (y*gain, up to +-2^48) is taken as
   a signed high-half multiply so the result matches msfa's arithmetic >>24
   (floor) bit-for-bit, with no 64-bit ops. */

/* msfa_umulhi32 (high 32 bits of an unsigned 32x32 product) comes from
   msfa_tables.h, included above. Its own name avoids clashing with runtime.c's
   umulhi32 when both land in one translation unit. */

/* ((int64)y * gain) >> 24, arithmetic (floor) shift, signed y, gain >= 0.
   Reconstructs the two's-complement 64-bit product's floor(>>24) from its two
   32-bit halves: signed hi-half = umulhi32 - (y<0 ? gain : 0); since the low
   half is unsigned, (hi<<8)|(lo>>24) equals floor(product/2^24) exactly. */
static inline int32_t msfa_mul24(int32_t y, int32_t gain) {
  uint32_t lo = (uint32_t)y * (uint32_t)gain;
  int32_t hi = (int32_t)msfa_umulhi32((uint32_t)y, (uint32_t)gain);
  if (y < 0) hi -= gain;
  return (int32_t)(((uint32_t)hi << 8) | (lo >> 24));
}

/* op_dx inlines the per-operator body (sin lookup, msfa_mul24, feedback) directly
   in its operator loop, so msfa_sin_lookup + msfa_mul24 are all this header exports. */
