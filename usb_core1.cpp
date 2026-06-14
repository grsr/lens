// Core 1: TinyUSB + SysEx thread loop, plus the other half of the audio graph
// in the SIO FIFO doorbell IRQ. tud_init() is called HERE (not main()) so the
// USB interrupt lands on this core's NVIC.

#include "usb_core1.h"
#include "lens_state.h"
#include "lens_sysex.h"

#include "tusb.h"
#include "pico/multicore.h"
#include "hardware/irq.h"
#include "hardware/structs/sio.h"

extern "C" { volatile uint32_t g_core1_loops = 0; }

// Audio doorbell: drain to the latest sequence, run the slice.
static void __not_in_flash_func(core1_doorbell_irq)(void)
{
    uint32_t seq = 0;
    bool got = false;
    while (multicore_fifo_rvalid()) { seq = sio_hw->fifo_rd; got = true; }
    multicore_fifo_clear_irq();
    if (got) lens_core1_slice(seq);
}

extern "C" void core1_entry(void)
{
    tud_init(0);

    multicore_fifo_clear_irq();
    irq_set_exclusive_handler(SIO_IRQ_PROC1, core1_doorbell_irq);
    // Audio doorbell below USB IRQ (0x80) so USB always preempts: a late slice
    // just holds its nodes one sample, but a missed USB packet breaks SysEx.
    irq_set_priority(SIO_IRQ_PROC1, 0xC0);
    irq_set_enabled(SIO_IRQ_PROC1, true);

    while (true) {
        ++g_core1_loops;
        tud_task();
        lens_sysex_task();
    }
}
