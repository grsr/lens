# Developer guide

This is for people who want to read, build or modify Lens itself. If you just
want to write patches, you want [loupe.md](loupe.md) instead.

The plan is to give you enough to find your way around. The code itself is
the truth; when something here disagrees with it, the code wins.

A note up front, since you'll probably feel it as you read: a lot of the
hairier parts of the compiler and the runtime were written by Claude Code.
The human assistant did his best to follow along and takes responsibility
for the bugs, but isn't 100% sure how some of it works ;) If something
looks strange but works, that's probably why.

## How it fits together

Lens is two halves that talk to each other through one file format.

**The compiler** (`compile.js`) takes Loupe text and produces a snapshot:
a compact, self-describing binary blob (`snapshot.h`) that lists every node
the patch needs and how they're wired. The snapshot is the only patch format
that exists. There is no JSON layer, no intermediate AST that travels, no
runtime representation that diverges from what was on disk.

**The runtime** (`loupe.h`) is a synchronous dataflow graph. The semantic
model is: at 48 kHz every node is recomputed, its new value commits at the
end of the sample, and the next sample reads what the previous one
committed. The actual schedule cheats on that to fit the ~20 microsecond
per-sample audio budget. Nodes with `interval <= 1` (audio plus edge
detectors and anything else that genuinely needs every sample) form a
must-run prefix that does run every sample. The rest is a control suffix
that runs in a round-robin slice per sample: a beat's worth of control
work spreads over a few samples, and stateful control nodes self-gate on
their clock (advancing by the elapsed delta when deferred) so a node fires
late but never skips. The visible behaviour matches the every-sample
semantics; the schedule is just how that fits in the budget.

Everything in the language compiles down to a node of one of about 25
kinds: oscillators, filters, tapes, gates, logic, routing. The
interpreter's main loop is `Recompute` (one switch over node kinds), and
`RunSchedule` walks the per-sample schedule.

The host (`main.cpp`) is the ComputerCard subclass that owns the audio
interrupt, reads knobs and jacks, drives the LEDs, manages flash and USB,
and feeds the runtime its per-sample context.

## The patch lifecycle

Every patch follows the same path, whether it arrived as Loupe text typed
into the web editor, was sent over USB SysEx from the CLI, lives baked into
the firmware as the factory default, or was loaded from flash at boot.

The compiler chews Loupe text into a snapshot, which is a compact binary
blob describing every node and how they're wired. Those bytes can travel
three ways: over USB as a SysEx message, into flash as the saved patch, or
into the firmware itself as the factory default (`tools/bake.js` does that
during a normal build). However it arrives, the card validates the magic
number and version, then calls `ApplySnapshot` which decodes the snapshot
straight into the runtime's live state. To keep the audio safe, the apply
happens at a quiet moment between beats rather than mid-sample.

The thing to know if you ever change the snapshot layout is that three
places have to agree about it: `snapshot_encode`/`snapshot_decode` in
`snapshot.h`, `serializeSnapshot` in `compile.js`, and the version constant
in each (`kSaveVersion` in `main.cpp`, `SAVE_VERSION` in `compile.js`).
Bump them together. There are no migrations: an old saved patch is just
rejected on version mismatch, and the user reloads from text.

## The dual-core split

The card has two cores and Lens uses both. The simplest way to think about
the division is: Core 0 is in charge of sound, Core 1 is in charge of USB.

Core 0 is where the audio interrupt fires, once per sample (48,000 times a
second, with about 20 microseconds to do its work). It runs most of the
per-sample compute, drives the jacks and LEDs, reads the panel, and is the
only thing allowed to write to flash. Core 1 handles the USB device stack
and the SysEx parser. USB has to live somewhere, and Core 0 was already
busy with audio.

The trick that makes them both useful at audio time: Core 0 hands a chunk
of each sample's audio-rate work to Core 1. It does this by writing a
sequence number into the inter-core FIFO, which fires an interrupt on Core
1. Core 1 then runs its assigned nodes and writes back a "done" number.
Core 0 commits Core 1's results on the next sample, once done matches what
it sent. If Core 1 wasn't ready in time, Core 0 just holds the previous
values for one sample and the affected nodes catch up next pass.

The handshake is lock-free because every shared field has exactly one
writer, so there's no mutex or wait. The shared state lives in `main.cpp`
as the `Core1Handshake c1_` struct. Within any one sample, every node
reads the previous sample's value (never the in-flight one), so the
cross-core split doesn't change what the music sounds like at all. A
single-core simulator (a dev tool that hasn't been released yet) produces
byte-identical output to the hardware.

A few things follow from this that are easy to get wrong:

- Don't call TinyUSB from Core 0. USB belongs to Core 1.
- `tud_init` has to run from `core1_entry` so that the USB interrupt is
  registered on Core 1's interrupt controller.
- Flash erase blocks the audio interrupt for tens of milliseconds, far
  longer than one sample. So `SaveToFlash` always reboots the card after
  writing rather than trying to resume.
- Every function on the per-sample audio path has to live in RAM (apply
  the `LENS_AUDIO_HOT` macro in `loupe.h`). If it lives in flash, a cache
  miss inside the audio interrupt will glitch the sound.

In terms of where to look: `loupe.h` has the per-sample kernels and the
schedule primitives (`RunMust`, `CommitMust`, `RunCtrl`, `CommitCtrl`,
`RunSchedule`). `main.cpp` has the per-sample orchestration, the
handshake, and the bridge methods that `usb_core1.cpp` calls into from
Core 1.

## Constraints to respect

- Per-sample audio budget on Core 0 is around 20 microseconds. The
  "audio-hot path" means anything reachable from `Recompute`, `RunMust`,
  `CommitMust` or `RunSchedule`: the per-builtin kernels, the schedule walk,
  the commit step. Anything you add there is in this budget.
- RAM usage hovers around 95% of 256 KB. New runtime state competes with the
  tape buffer; check `arm-none-eabi-size build/lens.elf` after a change. If
  you need to claw some RAM back to add a feature, the biggest single block
  is `kBufferBytes` in `tape.h` (currently 128 KB, the torus shared by every
  tape and sampling/delay buffer in the runtime). Halving it to 64 KB frees
  64 KB, at the cost of shorter maximum tapes and shorter delay times. It
  has to stay a power of two for the ring mask to work.
- Runtime DSP is 32-bit integer only. There's no `__aeabi_lmul` / `lldiv`
  in the audio path. For high-half products use `umulhi32` (see
  `onePoleStep` and `q16Mul` in `loupe.h` for the pattern).
- The 12-bit grid is the I/O boundary. Internal compute can go wider
  (Q12 / Q16 / 32-bit) but anything written to a tape, sent to a jack, or
  committed to a node's `value` is 12-bit at rest.
- Text is the only patch format. No JSON. The compiler explicitly rejects
  `{` at the top level.

## Build and run

The firmware build needs the Raspberry Pi
[pico-sdk](https://github.com/raspberrypi/pico-sdk):

```sh
cmake -B build
cmake --build build -j      # produces build/lens.uf2 (copied to repo root)
```

The compiler and tooling are pure Node:

```sh
npm install
node compile.js patches/turing-machine.loupe         # text to snapshot (binary on stdout)
node tools/bake.js                           # re-bake the factory default
node cli.js write patches/turing-machine.loupe       # send to a connected card via SysEx
```

The verify loop after a change is usually: build the firmware, re-bake the
factory if you touched compile output, flash the card, and listen.

There's also a local host-side simulator that compiles loupe.h into a
single-core binary and renders any patch to a WAV without hardware. It's
useful for diffing output byte-for-byte against an earlier build, but it
isn't ready to release yet. It may make it into this repo at some point.

## The two files to read

If you read nothing else, read these two. The compiler is `compile.js` and
the runtime is `loupe.h`. Almost everything interesting in Lens lives in
one or the other. The compiler turns text into a snapshot; the runtime
turns a snapshot into sound. Everything else is plumbing around those two.

## Gotchas worth knowing

- IDE clang diagnostics about `tusb.h`, `hardware/gpio.h`, or `ComputerCard.h`
  not found are noise: those headers are added by CMake at configure time
  and the build is fine. The real build is `cmake --build build -j`.
- A "magic mismatch" on a saved patch means stale flash from an older build;
  factory reset clears it.
- A "version mismatch" means `kSaveVersion` (main.cpp) and `SAVE_VERSION`
  (compile.js) are out of sync. Bump both.
- The USB product string is set in `usb_descriptors.c`. If you change it,
  the web UI's device filter (`/lens/i` in `web/app.js`) has to match or
  Connect won't find the card.
- `pico_enable_stdio_usb(lens 0)` is required; turning it on breaks the
  cable-detect normalisation probe.

## Where to start reading

If you want to understand the runtime: open `loupe.h`, find `Recompute`,
read the switch. Then look at one or two `op*` kernels (`opAudioPhasor`,
`opAudioWave` are representative). Then read `RunSchedule` and the
`RunMust` / `CommitMust` pair to see the per-sample shape.

If you want to understand the compiler: open `compile.js`, find
`compilePatch` near line 1350. It calls `normalizePatch`,
`expandAndClaimTapes`, then builds a `Compiler` instance and walks the
patch outputs. The actual per-builtin compilation is `Compiler.compileRaw`,
the long switch. Helpers like `expandTree` (macro expansion) and
`parseSignature` (`fn` signature parsing) sit above it.

If you want to understand the cross-core dance: open `main.cpp` and read
`ProcessSample`, `FireDoorbell`, `CommitCore1Slice`, `Core1Slice`. Then
`loupe.h`'s `RunMust` / `CommitMust` for what each core actually executes.

If you want to add a new builtin: there are roughly four places to touch.
Add a `NodeKind` enum entry in `nodes.js` (the JS side regenerates
`node_kinds.h` from it via `tools/gen_kinds.js`), add a `case` in
`Compiler.compileRaw` in `compile.js` for the surface syntax, add a `case`
in `Recompute` in `loupe.h` for the runtime behaviour (or write a small
`op*` kernel and call it from there), and bump the snapshot version if
your new node stores state the snapshot needs to round-trip. Pick an
existing simple builtin and follow its trail through those four files.

Have fun in there.
