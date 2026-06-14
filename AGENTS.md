# AGENTS.md

This file is for AI coding agents (and any human reading along). It's a
short pointer; the substance lives in the linked docs.

## What Lens is

A program card for the Music Thing Workshop System Computer (an RP2040 in
a Eurorack-style module). Users write patches in Loupe, a small parens-
and-S-expressions language that compiles to a dataflow graph the card runs
at 48 kHz. See `README.md`.

## Start here

- [`README.md`](README.md) for the user-facing overview, how to flash the
  card, how to run the editor.
- [`docs/loupe.md`](docs/loupe.md) for the language: patch shape, the
  cable, values, builtins, functions, modules. Read this before helping
  someone write a patch.
- [`docs/developer_guide.md`](docs/developer_guide.md) for the
  architecture: how the compiler and runtime fit together, the dual-core
  split, build instructions, the file map. Read this before changing
  code in the runtime or compiler.
- The Workshop System's own AI directive at
  [`Demonstrations+HelloWorlds/AI/WORKSHOP_COMPUTER_AI_DIRECTIVE.md`](https://github.com/TomWhitwell/Workshop_Computer/blob/main/Demonstrations+HelloWorlds/AI/WORKSHOP_COMPUTER_AI_DIRECTIVE.md)
  in the Workshop_Computer repo. Read it for the shared conventions and
  expectations across cards on this platform.

## Helping a user write a Loupe patch

Read `docs/loupe.md` first; that's the user-facing description of every
concept they're working with. Then look at the example patches in
`patches/` for working idioms (`hello.loupe`, `turing-machine.loupe`,
`dubdelay.loupe`, the files in `utility-pair/`).

A few things that come up often:

- The cable is always `<-`, sink-first, source last. Intermediate stages
  thread right-to-left: the rightmost thing is the source, and each stage
  to its left wraps everything to its right as its first argument. There
  is no `->`.
- Most builtin parameters accept streams, not just constants. If a user wants
  modulation, they wire a stream into the parameter (`(lpf in knob-y)`).
- Tapes can be authored (`(tape notes '(...))`), generated from a constant
  expression, or written into live with `<-` (that's how the Turing-style
  self-rewriting loops work).
- `(snap (random) :scale ...)` will pin to the top of the scale because
  random returns the full 0..vmax range. Always map random into a useful
  range first: `(snap (add 48 (spread (random) 25)) :scale minor)`.
- The truth about what each builtin does is in `compile.js`
  (`Compiler.compileRaw`, the long switch) and `loupe.h` (the per-builtin
  `op*` kernels). The compiler error messages are usually the fastest
  thing to read when you're stuck on a syntax question.

When the language docs disagree with the code, the code wins.

## House rules

These are not negotiable in this codebase:

- **No em dashes** in prose, comments, or docs. Use full stops, commas, or
  restructure. (Also in the global Claude config; restated here for visiting
  agents.)
- **No emojis** unless the user explicitly asks for them.
- **No JSON patches.** Patch text is Loupe S-expressions; the on-wire and
  on-disk format is a single binary snapshot. The compiler rejects `{` at
  the top level on purpose.
- **No 64-bit ops in the audio-hot path.** "Audio-hot path" means anything
  reachable from `Recompute`, `RunMust`, `CommitMust`, or `RunSchedule`.
  The M0+ has no hardware long-multiply or long-divide; using `int64_t`
  calls into flash veneers that stall the audio interrupt. Use `umulhi32`
  for high-half 32x32 products. See `q16Mul` / `onePoleStep` in `loupe.h`
  for the pattern.
- **Respect the dual-core split.** Core 0 owns the audio interrupt and
  flash. Core 1 owns USB and TinyUSB. Calling TinyUSB from Core 0 will
  silently break things. See the dev guide for the handshake details.
- **No backcompat shims.** When the snapshot or SysEx format changes, bump
  the version and break old data. No migrations.
- **Simple over clever.** The compiler's ~80-case switch over builtins
  and the runtime's per-builtin kernels are flat on purpose. Don't
  propose visitor patterns, dispatch registries, polymorphic
  abstractions to replace them. Flat is readable.
- **The language surface is deliberately bigger than the shipped patches
  use.** Don't remove a builtin or option just because no shipped patch
  exercises it. That extra surface is intentional, for users to discover.
- **Comments are sparse on purpose.** The codebase was through a deliberate
  cull. Add a comment only when the *why* is non-obvious (a hidden
  constraint, a hardware quirk, a surprising invariant). Don't restate
  what the code says.

## Working with the codebase

After any non-trivial change to the runtime, compiler, or snapshot format,
verify:

```sh
cmake --build build --target lens -j      # firmware must build, RAM under 96%
node compile.js patches/turing-machine.loupe > /dev/null    # compiler smoke test
node tools/bake.js                                  # re-bake factory if defaults affected
node tools/build_web.js                             # web editor self-tests every shipped patch
```

Real hardware is the only place to fully verify audio behaviour; if a
change touches DSP or the schedule, flag in your PR that listening tests
are still needed.

Lens is a hobby project shared as-is. Treat it accordingly: take care, but
have fun. Bugs are expected. A clear minimal repro in an issue is welcome;
a PR with a fix is more welcome.
