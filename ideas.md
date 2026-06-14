# ideas

Things to do and things to try, in no particular order.

- `opAudioFollow` still uses a 64-bit divide on the locked-ratio path. The
  rest of the audio code is 32-bit only. Want to find a 32-bit version.
- Web editor: show a must-run node count alongside the existing
  "N nodes / B bytes" status line, so you get a feel for how close a
  patch is getting to the per-sample audio budget.
- Autogenerate a `docs/builtins.md` from the `case "X":` comments in
  `compile.js` and run it on build, so the reference always matches the
  compiler. Probably wants a quick standardisation pass through the case
  comments first so the output reads cleanly.
- Hardware-test every shipped patch end-to-end, especially `drum-kit`
  now the `if`/clocks bug is fixed, and `rungler` (which has never been
  tried).
- The `utility-pair/` patches mostly work but several want parameter
  tuning by ear on hardware before they sound musical.
- The cable (`<-`) might still benefit from a word name (`into` / `wire`)
  to look less like magic syntax. Decided against during 0.1 release
  prep but worth revisiting if newcomers keep stubbing their toes.
- Should `(<- c ...)` on a plain `def`-bound value implicitly promote it
  to a one-register self-reference, removing the need for `feedback`?
  Probably not, but worth chewing on again.
