# ideas

Things to do and things to try, in no particular order.

- `opAudioFollow` still uses a 64-bit divide on the locked-ratio path.
  The rest of the audio code is 32-bit only. Want to find a 32-bit
  version.
- Autogenerate a `docs/builtins.md` from the `case "X":` comments in
  `compile.js` and run it on build, so the reference always matches
  the compiler. Probably wants a quick standardisation pass through
  the case comments first so the output reads cleanly.
- Hardware-test every shipped patch end-to-end, especially `drum-kit`
  now the `if`/clocks bug is fixed, and `rungler` (which has never
  been tried).
- The `utility-pair/` patches mostly work but several want parameter
  tuning by ear on hardware before they sound musical.
- The cable (`<-`) might still benefit from a word name (`into` /
  `wire`) to look less like magic syntax. Decided against during 0.1
  release prep but worth revisiting if newcomers keep stubbing their
  toes.
- Should `(<- c ...)` on a plain `def`-bound value implicitly promote
  it to a one-register self-reference, removing the need for
  `feedback`? Probably not, but worth chewing on again.
- Web editor: show a must-run node count alongside the existing
  "N nodes / B bytes" status line, so you get a feel for how close a
  patch is getting to the per-sample audio budget.
- Phase distortion synthesis (Casio CZ style) on `sine`/`saw` etc.
- PM as a phasor builtin (today it's a shape feature; works fine for
  one-phasor-one-shape, but for sharing a PM-modulated phase across
  several shapes the phasor would need to expose a modulated phase).
- Variable-length tapes (capped). Compile-time sets each tape's MAX length and reserves
  the buffer slot; the tape's CURRENT length is a stream that drives reads and writes.
  Cheaper than a general allocator (slot stays fixed, no fragmentation), but unlocks
  musical territory: a knob that turns a 16-step pattern into 5 steps without
  reallocating, Turing tapes that breathe, polyrhythms by length-modulating two tapes
  at the same clock. `(len tape)` becomes a stream rather than a const; downstream
  modulo / scaling math evaluates per sample. Patch syntax could be
  `(tape ops :max 16 '(same oct flip oct))` + `(set-len tape knob-x)` or similar.
- `loadPatch` emits a JSON-shaped intermediate (`{tapes, outputs, records, prelude}`)
  with stringified s-exprs that the compiler then re-parses. From before the language
  settled on pure s-expressions. A focused refactor could pass one parsed tree through
  from source to graph, killing the re-parse and letting forms like `(len prog)` resolve
  in one pass.
- Shadow `.phase` and `.level` in `NodeState` the way `.value` is shadowed.
  `BalancePartition` carries a colocate + recordhead-pin patchwork to
  stop cross-core unshadowed reads, kept in sync with `CoLocateTarget`
  in `loupe.h` — every user-facing op is covered, but every new op a
  runtime author adds that reads `.phase`/`.level` from another node
  needs an entry there or it silently races. Shadowing would close the
  whole class: every op operates on a working `NodeState` copy, framework
  promotes the shadowed fields at commit, the colocate patchwork goes
  away. Cost is ~30 op signature changes and a ~2 KB RAM bump (offset
  by shrinking `.value`/`.next` to int16). Right shape: working-copy
  pattern in `RunSlot`, every op gains a `NodeState& st` parameter.
