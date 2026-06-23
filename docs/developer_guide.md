# Developer guide

For people who want to read, build, or modify Lens. If you only want to write
patches, read [loupe.md](loupe.md) instead.

This guide is the map. When it disagrees with the code, the code wins. The C
runtime in particular is the source of truth for what every kernel does.

## Repo layout

```
compiler/   Loupe source -> snapshot pipeline (pure JavaScript)
runtime/    the C runtime, the hardware shell (main.cpp), and the snapshot decoder
cli/        the dev CLI and the sysex wire protocol
web/        the web editor (the primary user interface)
tools/      build helpers and lookup-table generators
patches/    example patches
docs/       this documentation
attic/      prototype, shelved notes, and golden fixtures (gitignored)
prelude.loupe   the standard library, loaded before every patch
CMakeLists.txt, pico_sdk_import.cmake, LICENSE, package.json, ComputerCard.h
```

## How it fits together

The compiler is pure JavaScript on the host. It turns a patch into a flat
binary snapshot. The runtime is C on the card: it decodes the snapshot into a
wired graph and walks it once per audio sample, at 48 kHz. No scheduling
decisions happen at run time; the order, the rates, the wiring and the
core partition are all baked into the snapshot.

The whole design is one flat list of slots. Each slot holds a 12-bit value (or
a small state struct whose first field is that value) and a kernel function
pointer. A walk step is one indirect call per slot. The compiler does the hard
work; the runtime stays dumb.

## The compiler pipeline

Each stage is one file in `compiler/` and reads in isolation. `compile-pipeline.js`
chains them.

| Stage | File | Job |
|---|---|---|
| Reader | `reader.js` | Loupe text to AST (S-expressions) |
| Expander | `expander.js` | Resolve names, inline `fn`, expand special forms (`<-`, `use`, `tape`, `lens`, `score`, `normal`, sugar) |
| Lowerer | `lowerer.js` | Build the slot graph; select a kernel per node; assign tape/audio buffers |
| Scheduler | `scheduler.js` | Global topological sort; dual-core partition; single-writer verify |
| Snapshot | `snapshot.js` | Binary-encode the scheduled graph |

`prelude.loupe` is loaded into the base environment before every patch. It holds
every constant, hardware-jack name, scale, rhythm, and builtin signature with
kwargs and a docstring. A patch can shadow any prelude binding.

**Reader** turns source text into numbers, symbols, keywords and lists.

**Expander** resolves names against the prelude and patch environment, inlines
`fn` calls, and expands the special forms: the `<-` cable, `use`, `tape`,
`audio`, `lens`, `score`, `normal`, and the sugar forms. It returns a flat list
of slot records with resolved inputs. Op-lens calls (`(thru ops idx)` applied to
an argument) are inlined here, so the later stages never see a half-applied lens.

**Lowerer** turns the expanded graph into slots, selecting the concrete kernel
name for each node from its argument pattern (for example, a record-head cable
becomes a per-sample or per-cell variant), and assigns buffer objects to tape,
audio and wave nodes. It also records the state-field schema for each kernel
family, which the single-writer verifier uses.

**Scheduler** produces one global topological order over every slot, partitions
it between the two cores by estimated cycle cost, and runs the single-writer
verifier. The verifier checks that no `(slot, field)` pair has more than one
writer; a violation makes the snapshot stage reject the graph. Stub kernels (ops
that are declared but not yet implemented) are also caught here so they never
reach a card. There is no rate classification: every slot is in the one order,
and the runtime decides per slot whether to run or skip it this sample.

**Snapshot** binary-encodes the scheduled graph. Header (magic, version, slot
counts, K, buffer/terminal/kernel-registry counts), the kernel-name registry,
the slot table, the buffer and terminal tables, and a trailing CRC-32.
Little-endian. There is a size cap the encoder enforces before any USB
round-trip.

## The runtime

`runtime_step` in `runtime/runtime.c` is the per-sample entry point. Each
sample it:

1. Refreshes the hardware-input scratch from the `HardwareInputs` struct.
2. Walks every slot once in topological order, calling each slot's kernel. Each
   slot reads its inputs' freshly written outputs from this same tick. A slot is
   run unconditionally if it is an integrator (state advances every sample:
   oscillators, filters, envelopes, edge/pulse counters, hardware reads); any
   other slot is skipped when all of its 12-bit inputs are unchanged since it
   last ran (`step_slot`, a pure cost optimisation, never a semantic tier).
3. Commits record-head writes: cells written this tick become visible to tape
   readers next tick.
4. Publishes cross-core shadows and drives the terminals: reads each terminal's
   slot output and writes it to the matching `HardwareOutputs` field.

Dispatch is a function pointer per slot. At apply time `snapshot_apply` resolves
each kernel name to an index into the `KFN` table and stores the function
pointer on the slot, so a walk step is one indirect call, no switch.

The state pool is static; there is no malloc. Audio buffers are 12-bit packed
(three bytes per two cells); the 128 KB audio pool holds roughly 1.82 seconds at
48 kHz, which is the ceiling on total tape and delay length. A separate small
pool holds the sequence tapes.

**Free feedback.** Slots walk in topological order, so each reads its inputs'
fresh outputs. Cycles get an implicit `z1` inserted by the compiler at one
back-edge, so the back-edge read sees the previous tick's value. No cycle
detection at run time; the snapshot already encodes a safe order.

**Single-writer.** Every state field has exactly one writer by construction, and
the scheduler proves it at compile time. This is what makes the design safe
without mutexes, on one core or two.

### Kernels

The kernel bodies all live in `runtime/runtime.c` as `op_*` functions, each
marked for RAM placement so it stays off the flash bus on the audio path. They
cover arithmetic and logic, oscillators and edge detectors, filters and
dynamics, envelopes, the drum voices, and the tape and record-head ops. The
name-to-id table (`KTABLE`) and the function-pointer table (`KFN`) are in the
same file; `snapshot_apply.c` looks names up through `runtime_find_kernel`.

A pure arithmetic kernel writes an `int32_t` to its slot output. A stateful
kernel owns a state struct at the slot output and writes its output field plus
any per-kernel state (phase accumulator, filter memory, and so on).

## Run or skip

There is no rate tier. Every slot is in one topological order and is eligible to
run every sample; the runtime just decides per slot whether to. An integrator
(its state advances every sample: oscillators, filters, slews, envelopes, the
drum voices, edge and pulse counters, wave/tap cursors, hardware reads) always
runs. Any other slot is skipped on a sample where all of its inputs are bit-for-
bit unchanged since it last ran, because its output cannot have changed either.
A still patch then costs little beyond the audio path, and a sequencer's burst
of pure-op work on a beat only happens on that beat. `runtime_step_reference`
runs every slot unconditionally and is the oracle the skipping walk is diffed
against, bit for bit.

## Adaptive dual-core

The scheduler always produces a two-core partition (each slot record carries a
core byte), and the firmware always builds the full dual-core path: core 0 drives
the audio interrupt and rings a doorbell, core 1 runs its slice in parallel.

Cross-core reads are made race-free by the single-writer property plus a shadow:
a consumer on one core reads a shadow of a producer on the other core, and the
shadows are republished at the window boundary after both core walks complete.
That gives cross-core edges a deterministic one-sample lag while intra-core
reads stay fresh.

Dual-core execution engages only when the partition actually places slots on
core 1 (`dual_active`). For the current corpus the cost model keeps every slot on
core 0, so the card runs core 0 only and deterministic, with the core-1 doorbell
path live and ready for heavier patches once cost calibration moves work onto it.
On-hardware confirmation of the dual-core timing is the open item.

Core 1 also runs the TinyUSB device stack and the sysex parser. The patch-swap
handshake is lock-free by single-writer: core 1 stages an incoming snapshot and
sets a ready flag; core 0 reads it at the next sample boundary, calls
`snapshot_apply`, and swaps the runtime pointer.

## Sysex transport

Frame: `F0 7D 4C 45 <cmd> <8-into-7 payload> F7`. The manufacturer id is
`7D 4C 45` (educational id plus `LE`); payload bytes are 8-into-7 packed so
every byte stays below `0x80`. Commands are defined in both `cli/sysex.js` and
`runtime/sysex.h`: write/read state, save to flash, factory reset, ping, and the
diagnostic and perf queries (diag, perf, slot-perf) with their matching dump
responses. The web editor uses the same framing layer as the CLI.

## Tools

`tools/` holds the build and codegen helpers: `build_web.js` bundles the
compiler and prelude for the web editor, the `gen-*.js` scripts regenerate the
pitch / rate / sine lookup tables baked into the runtime, and `cost.js` does
static per-slot cost estimation over the kernel cost tables.

## Build and flash

**Firmware.** Needs the Raspberry Pi
[pico-sdk](https://github.com/raspberrypi/pico-sdk) (set `PICO_SDK_PATH`):

```sh
cmake -B build
cmake --build build -j
```

cmake runs `runtime/bake_factory.js` first, which compiles `patches/hello.loupe`
into `runtime/factory_snapshot.h` (the patch embedded in the firmware). The
build produces `lens.uf2` and copies it to the repo root. Flash it by mounting
the card as the `RPI-RP2` USB drive and copying `lens.uf2` onto it.

`LENS_PERF_PROBE` (default on) is a cmake cache option that compiles in the
per-sample cycle probe behind the `perf` / `slot-perf` sysex queries.

**JS tooling.**

```sh
npm install
node cli/cli.js write patches/turing-machine.loupe   # compile -> snapshot -> WRITE_STATE
node cli/cli.js write ... --save                      # also flash it on the card
node cli/cli.js ping                                  # handshake
node cli/cli.js watch patches/hello.loupe             # live-code loop, re-push on save
node cli/cli.js perf                                  # read perf counters
```

## Adding a builtin

Three places:

1. Add `(def name (fn (...) :kwargs (...)))` to `prelude.loupe` with a docstring.
2. Add the JS kernel to the interpreter in `compiler/interp.js`.
3. Add the C kernel `op_name` to `runtime/runtime.c` and register it in `KTABLE`
   (and `KFN`).

Then run the validator (`compiler/validate.js`) to confirm the prelude, the
interpreter and the C kernel table agree, and add fixture cases for the new
kernel.

## Testing

The host runner (`runtime/test/host_runner`) runs a compiled snapshot against a
per-sample input trace. The gates compare the optimized walk against the
`runtime_step_reference` oracle bit for bit (`attic/tests/oracle-diff.js`), hold
behaviour across refactors with golden traces (`golden.js`), and drive an
impulse through the audio buffers (`audio-gate.js`). The gate scripts live under
`attic/` (gitignored).

## Hardware constraints

- RP2040 Cortex-M0+ overclocked to 250 MHz at 1.15 V. Roughly 5,200 cycles per
  sample at 48 kHz.
- No hardware divide, no 64-bit multiply, no FPU on M0+. All DSP is 32-bit
  integer; use `umulhi32` for high-half products.
- 256 KB RAM, and it is tight (well above 90% used). The 128 KB audio pool
  dominates and is the point. The audio path is flash-resident code pinned into
  RAM via `__not_in_flash_func`. Check the linker memory report after adding any
  static pool, and mark any new function on the `ProcessSample` / `runtime_step`
  call tree with `__not_in_flash_func`.
- 2 MB flash. A flash save blocks the audio loop for tens of milliseconds and
  reboots the card.

## Gotchas

- IDE clang diagnostics about `ComputerCard.h` not being found are harmless; the
  real build is `cmake --build build`.
- `vreg_set_voltage` and `set_sys_clock_khz(250000, true)` must run before
  `board_init()` in `main()`. Do not reorder them.
- `pico_enable_stdio_usb(lens 0)` is required: enabling USB stdio breaks the
  ADC normalisation probe that detects whether a jack is patched.
- The factory snapshot regenerates automatically under cmake. If you compile
  outside cmake, run `node runtime/bake_factory.js` from the repo root.

## Heritage

These attribution comments must survive every refactor:

- Drum voices after Mutable Instruments Plaits (Émilie Gillet).
- The band-limited sawtooth and the Utility-Pair lineage after Chris Johnson.
- The ADC self-heal / normalisation probe after Vincent Maurer's Grains card,
  preserved in `ComputerCard.h`.

## Where to start reading

- **Compiler:** `compiler/expander.js` for how Loupe forms expand, then
  `compiler/lowerer.js` for kernel selection, then `compiler/scheduler.js` for
  the topological order and single-writer verifier.
- **Runtime:** `runtime/runtime.c` for the per-sample walk and the kernels, then
  `runtime/snapshot_apply.c` for how a snapshot becomes a wired graph.
