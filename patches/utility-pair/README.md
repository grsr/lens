# Utility Pair, in Loupe

A homage to Chris Johnson's [Utility Pair](https://www.chris-j.co.uk/utility_pair/)
([source](https://github.com/chrisgjohnson/Utility-Pair)), a set of small utilities for the
Workshop System Computer.

These are **reimplementations in Loupe, not ports of his C++** — each captures the *idea* of a
utility (what it does, its controls) rebuilt from Loupe primitives, so they show how everyday
modular tools fall out of the language. They are not bit-for-bit equivalent to the originals, and
the DSP is Loupe's own. A few are modelled more closely on his approach (e.g. the symmetric
detune spread in `supersaw`); those say so in the file. All credit for the original concept and
collection goes to Chris Johnson.

Each utility is a standalone **library function**: it takes its inputs as parameters and exposes
its outputs as ports, so it binds no hardware of its own. A *pair* patch `use`s two of them and
wires each to one half of the faceplate, left (audio/cv/pulse-in 1, knob-x, led-0) and right
(jacks 2, knob-y, led-3). `pair.loupe` is the canonical example (a lopass gate + the Buchla
wavefolder); swap the two `use` lines for any other pair. Because they are plain functions, any
patch can draw on them as a library:

```lisp
(use utility-pair/echo)              ; relative to this file's directory
(patch (<- audio-out-1 (echo audio-in-1 knob-x knob-y)))
```

Names that would collide with a built-in form are renamed: `vca` → `amp`, `delay` → `echo`,
`euclid` → `euclid-seq`. Normalling (an unpatched input falling back to noise / an internal
clock) lives in the *calling* patch via `(normal in fallback)`, since a function never sees the
hardware faceplate. A good place to see how everyday modular tools fall out of the language.
