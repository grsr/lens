# Loupe

Loupe is the language you write Lens patches in. The syntax is Lisp-flavoured,
because nested parens turned out to be a clean way to describe a patch in text.
The compiler wires the patch up; the runtime walks the wires 48,000 times a
second, and the values that fall out drive the jacks.

This is enough to get you started. It is not a complete reference. The truth is
`prelude.loupe` (every builtin, its arguments, and a docstring in the comment
above each `def`) and the runtime in `runtime/`. When something here disagrees
with them, the code is right.

## A patch

A patch is one S-expression. The simplest one plays a sine on the first audio
output:

```lisp
(patch
  (<- (audio-out :1) (sine :note A4)))
```

Two kinds of line: things you name (with `def`), and cables (with `<-`) that
wire things into the card's outputs.

```lisp
(patch
  (def master (clock :tempo (knob :x)))
  (def melody (tape '(C3 Eb3 G3 Bb3)))
  (<- (cv-out :1)    (v-oct (step melody)))
  (<- (pulse-out :1) (trig)))
```

The patches in `patches/` show more shapes. `hello.loupe`, `hello-seq.loupe`,
`turing-machine.loupe` and `discreet-system.loupe` are good starting points.

## Values

Everything in Loupe is a 12-bit value (0..4095), because that is what the
card's converters deal in: the ADC reads 12 bits, the DAC writes 12 bits, so a
value at rest is just what the jacks and panel give and take. A jack then
decides what the value means: an audio output reads it as a sample, a CV output
as a voltage, a pulse output as a gate (high above the midpoint). The same
value driving two different jacks does two different things.

So there are not separate "audio" and "control" worlds. There is one domain,
and the consumer decides. An oscillator can be modulated by a slow phasor; a
tape of notes can drive a pitch jack or a gate jack; an envelope can shape
audio or open a filter.

Three constants are always in scope, written in capitals by convention (capitals
mean a constant):

- `VMIN` (0): floor, "off".
- `VMID` (2048): bipolar centre, "middle".
- `VMAX` (4095): ceiling, "full".

`OCTAVE` is 12. Note names like `C3`, `Eb4`, `G#2` are bound in the prelude as
ordinary MIDI numbers, so you can use them in any arithmetic expression:
`(add C3 OCTAVE)` is a C4.

## The hardware jacks

Every hardware jack uses one call-form, inputs and outputs alike:

```
(name :label [:interpretation ...])
```

The label is a keyword, read as "the jack labelled 1", not as arithmetic. An
out-of-range label is a compile error that names the valid set. Jacks are
direction-typed: reading an output or writing an input is a compile error.

**Inputs** (used in value position):

- `(cv-in :1)`: a CV input, unipolar 0..VMAX (an unpatched jack reads the
  midpoint). `(cv-in :1 :bipolar)` centres on 0 (unpatched reads 0), which is
  what you want when you sum a CV onto a knob as modulation. `(cv-in :1 :v-oct)`
  reads the jack as a pitch.
- `(audio-in :1)`: an audio input.
- `(pulse-in :1)`: a pulse/gate input.
- `(knob :main)` / `(knob :x)` / `(knob :y)`: the three knobs, raw by default.
  Pass `:detent` to snap cleanly to the rails and centre past ADC jitter, or
  `:detent N` to set the snap-zone half-width.
- `(switch :z)`: the Z-switch. Returns one of the three rails (`VMIN` down,
  `VMID` middle, `VMAX` up), so a switch is a three-position knob in the same
  value domain.
- MIDI, from a USB keyboard plugged straight into the card or notes from a
  computer: `(midi-note)` (held pitch), `(midi-gate)`, `(midi-velocity)`,
  `(midi-cc :1)` (CC number 1, the label names the CC), `(midi-bend)`,
  `(midi-pressure)`, `(midi-trig :note 60)` (a trigger per note-on of one key),
  and `(midi-clock)` / `(midi-playing)` for transport. Add `:ch N` to read one
  channel; omit it for omni.

**Outputs** (used as the sink, the left side of a `<-`):

- `(<- (cv-out :1) expr)`: a CV output. `:bipolar` is available here too.
- `(<- (audio-out :1) expr)`
- `(<- (pulse-out :1) expr)`
- `(<- (led :0) expr)`: the panel LEDs, 0..5.
- `(<- (midi-note-out :ch 1) pitch :gate g :vel v)`: send MIDI notes; the gate
  decides note-on/off. `(<- (midi-cc-out :ch 1 :cc 1) value)` sends a CC, and
  `(<- (midi-clock-out) clk)` sends MIDI clock, so the card can drive a synth or
  a DAW.

For a shorter name, define your own alias: `(def out (cv-out :1 :bipolar))`.

`(normal jack default)` reads a jack but falls back to `default` when nothing
is patched in. It is how a patch takes an external clock when one is present
and runs on its own tempo otherwise:

```lisp
(def master (normal (pulse-in :1) (clock :tempo (knob :x))))
```

## The cable

A Loupe patch is a eurorack patch written down. You name an output jack and
trace the cable back to where the signal comes from. `<-` is that cable: the
value on the right flows into the destination on the left.

```lisp
(<- (audio-out :1) (vca (sine pitch) env))
```

reads "audio-out 1 is fed by the sine, through the vca." The destination on the
left can be a jack, an LED, a tape, or a named output of a function you wrote;
everything to the right of it is the signal.

When the signal is a chain, write the stages one per line and let the cable
thread them right-to-left. The last stage is the source; each stage above
receives the running signal as its **first** input:

```lisp
(<- (audio-out :1)              ; out
    (vca env)                   ;  through a vca (env is the amp)
    (lpf :cut 1500)             ;  through a low-pass at 1500
    (sine pitch))               ;  from a sine
```

That is exactly `(vca (lpf (sine pitch) :cut 1500) env)` unfolded into a flat
column. The chain is pure sugar for the nested form, so the two are
interchangeable and you can always fall back to nesting.

Read top-to-bottom it is the signal path, which makes the spine of a patch read
like its diagram. The branches (a side-chain like `env`, or a signal that fans
out to two places) are the cables that come in from the side: declare them as a
`def` just above and reference them by name.

The thread always lands the signal in a stage's first input. When a stage needs
it somewhere else, or you want a non-default port off a multi-output function
mid-chain, break that stage out into a `def` and reference it. Every line that
wires something into a destination starts with `<-`.

## Builtins

This is a starting handful, not a reference. Every builtin is declared in
`prelude.loupe` with its arguments, keyword arguments, and a one-line docstring.
The runtime kernels live in `runtime/`.

- **Oscillators:** `sine`, `triangle`, `saw`, `square`, `phasor`, `noise`.
- **Tapes (memory):** `tape`, `audio` (a blank audio buffer), `step` (read one
  cell per clock tick), `seek` (read at an index), `lookup` (read an index of a
  given tape), `wave` (play a tape as a sample or wavetable), `tap` (read behind
  an audio buffer's write head -- a delay).
- **Clocks and time:** `clock` (the master), `follow` (a derived clock at a
  ratio), `trig` (a trigger pulse on each wrap, the downbeat; defaults to master), `turns`, `every` (a divider),
  `euclid`.
- **Filters and shaping:** `vcf` (resonant SVF: lp/hp/bp/notch), `lpf`/`hpf`
  (one-pole), `average`, `lpg`, `slew`, `wavefold`, `crush`, `envfollow`,
  `clip`, `saturate`.
- **Envelopes and gain:** `envelope`, `vca`, `ring`, `mix`.
- **Arithmetic flags:** `add`/`sub` accept `:sat` to saturate instead of wrap.
- **Pitch:** `v-oct`, `snap`, `quantise`, `transpose`, `degree`, `pitch`.
- **Logic and gates:** `if`, `chance`, `trig`, `fall`, `toggle`, `schmitt`, `hold`,
  `gate`, `diff`, `max`, `min`, `abs`, `rect`, `window`, `connected`, `normal`.
- **Random:** `random`, `walk`, `spread`.
- **Drums:** `kick`, `snare`, `hat`, and `groove`, a kit builder that triggers
  each voice on its `:on` rhythm pattern and mixes them.
- **FM:** `(dx :bank N :preset P :pitch note :gate g :decay d :tone t)` plays a
  6-operator DX7 voice from a flash bank; `:bank`/`:preset` pick the voice,
  `:tone` shifts FM brightness. See "Loading DX7 voice banks" in the README.
- **Selection and routing:** `thru`, `squint`, `switch`.
- **MIDI:** in with `midi-note`, `midi-gate`, `midi-velocity`, `midi-cc`, `midi-bend`,
  `midi-trig`; out by writing `(midi-note-out :ch N)`, `(midi-cc-out ...)`,
  `(midi-clock-out)`. Play the card from a USB keyboard plugged straight into its
  USB-C port or from a DAW, or have it drive an external synth or clock. The
  `midi-*.loupe` patches show both directions.

Most builtins take keyword arguments (`:cut`, `:trig`, `:scale`, `:decay`, and
so on) on top of positional ones. Pass an unknown keyword and the compiler
error names the keywords that builtin actually accepts.

### Clipping and saturation

`(clip in)` hard-clips a signal to the bipolar audio rails. Use it before writing
into an audio buffer: buffer writes wrap (not clamp), so an out-of-range signal
flips polarity and crackles. `clip` before the write prevents that.

`(saturate in :drive d :bias b :mix m :level l)` is a cubic soft-clip. `:drive`
pre-gains the signal into the curve; `:bias` (bipolar) skews it for even-harmonic
warmth; `:mix` blends dry and wet; `:level` is output makeup gain. Use it to
colour a signal rather than to stop crackle.

`(add a b :sat)` and `(sub a b :sat)` saturate at the value rails instead of
wrapping. Useful when you want overflow to stop at the ceiling rather than fold.

### Connection detection

`(connected jack)` returns `VMAX` when a cable is physically patched into the
jack, else 0. The check is hardware, so a clock signal that dips to 0 between
edges still counts as connected.

`(normal jack default)` is sugar: it reads `jack` when connected, and `default`
otherwise. The common idiom:

```lisp
(def master (normal (pulse-in :1) (clock :tempo (knob :x))))
```

## Phasors

A phasor is a ramp that climbs from 0 to its top and wraps, over and over. It is
the engine inside every oscillator and also inside every clock. That is one of
the things Loupe takes seriously: a slow phasor is a clock, a fast one is an
oscillator, and there is no real boundary between them. A clock at audio rate is
an oscillator; an oscillator slowed to one cycle per beat is a clock. The same
builtin, `phasor`, makes both.

You usually do not write `phasor` directly: `(clock :tempo (knob :x))` and
`(sine :note A4)` both build one for you. Knowing it is the same thing explains
why you can ride either through `follow` for a locked or drifting ratio, or read
either one's phase to walk a tape.

A phasor has one named output: `:phase`, the ramp itself. A bare `(phasor ...)`
used as a value is that ramp. To get a beat pulse, edge-detect the ramp wrap with
`trig`:

```lisp
(def osc (phasor :tempo (knob :x)))
(<- (cv-out :1)    (osc :phase))   ; the ramp, e.g. a tape motor
(<- (pulse-out :1) (trig osc))     ; a pulse on each wrap
```

`clock` is phasor sugar: `(clock :tempo t)` is `(phasor :tempo t)`, which is why
a clock and an oscillator are the same engine read two different ways.

`:sync` locks a phasor to an external pulse. `(phasor :sync (pulse-in :1))`
measures the period between incoming edges, runs at that rate, and resets its
phase on each edge, so a coarse trigger becomes a smooth continuous phase you can
subdivide or use as a tape motor. Give it a rate as well, `(phasor :hz 10 :sync
p)`, and the edge hard-resets the phase instead. An external pulse has to stay
high for at least 64 samples (about 1.3 ms) to count; a single noisy sample
is ignored, not a tick.

## Tapes

A tape is a passive buffer of 12-bit cells with a maximum length. It does not
know whether it holds notes, control values, or audio; a sample is just a 12-bit
value like everything else. The logic lives in the heads that read and write it,
which is why loopers, delays and granular all come out of a tiny runtime.

You can author a tape (`(tape '(C3 D3 G3))`), build one from a pattern helper,
or declare a blank one and write into it live:

```lisp
(def buf (audio :seconds 1.5))   ; 1.5 s of empty audio buffer
```

The pattern builders write rhythms and melodies as quoted lists and return a
tape:

```lisp
(beat  '(x . x .))        ; gate values: x is a hit, . is a rest
(notes '(C4 E4 G4 B4))    ; MIDI pitches
(score '(C4 _ E4 ~))      ; pitch tape plus a gate tape; _ rests, ~ ties
```

`score` returns two ports, `:notes` and `:rhythm`, that you pick apart the same
way you read a multi-output function (below). The prelude also ships named
rhythms to start from and mutate: `four-on-floor`, `backbeat`, `eighths`,
`tresillo`, `son-clave`, `bossa`, and more.

### Reading and writing a tape

`step` reads one cell per clock tick. `seek` reads at an explicit index.
`lookup` reads a given tape at an index. A tape also behaves like a function of
an index: `(t i)` reads cell `i`, and `(<- (t i) v)` writes `v` there, so a patch
can read and rewrite its own cells at arbitrary positions. Writing into a tape is
otherwise just a `<-` cable whose sink is the tape, carrying extra keywords for a
clocked or streaming write head:

- `:trig C` drives the write head from clock `C` (default: master).
- `:per-sample` writes one cell per audio sample.
- `:len L` caps the head's cycle length (a literal or a stream).
- `:when G` only writes while `G` is nonzero.
- `:blend F` composites the new value into the existing cell with a function
  `(:old :new)`.

A live wavetable looper writes audio into a buffer one cell per sample while a
switch is up, then reads it back as one oscillator cycle:

```lisp
(patch
  (def loop (audio :seconds 1.5))
  (<- loop (audio-in :1) :per-sample :when (eq (switch :z) VMAX))
  (<- (audio-out :1) (wave loop :midi (knob :main))))
```

The dub delay writes the filtered input plus an attenuated echo back into the
same buffer, and reads behind the write head with `tap`:

```lisp
(patch
  (def buf  (audio :seconds 1.5))
  (def echo (tap buf :amount (knob :main) :span :interp))
  (<- buf
      (vcf :in (add (audio-in :1) (vca echo (knob :y)))
           :cut (knob :x) :res 1500
           :port lp)
      :per-sample)
  (<- (audio-out :1) (add (audio-in :1) echo))
  (<- (audio-out :2) (audio-in :1)))
```

The card has 128 KB of RAM for everything tapes live in. Long samples and long
delays compete with everything else for memory, and you hit the ceiling fast.
Treat it as a fun constraint.

## Clocks

A clock is a slow phasor. When the phase rolls over, the clock fires. `(clock :tempo (knob :x))` makes the
master; the prelude already defines `master`, and most readers (`step`, `tap`,
`wave`) take a `:trig` argument that defaults to it. `trig` converts a clock (or
any signal) to a trigger pulse on each falling edge (for a phasor, the wrap, which
marks the downbeat), defaulting to master: `(trig)` and `(trig master)` are the same.
`follow` derives a related clock: `(follow master :div 4)` runs a quarter as
fast, `(follow clk :mult 4)` four times as fast. `every` divides one.

The pulse a clock or trigger emits is 65 samples wide by default (about
1.35 ms). That is snappy but barely visible, so widen it with `:width` when you want a longer gate
or a light you can see: `(clock :tempo t :width 480)`. To blink an LED on the
beat, put an envelope on the trig rather than stretching it.

## Feedback

The runtime walks every slot in topological order each sample, so each slot
reads its inputs' freshly computed values. Cycles in the graph are allowed: the
compiler finds each cycle and inserts a one-tick delay (`z1`) at one back-edge
automatically. At audio rate that delay is the z^-1 every IIR filter is built
on, and inaudible.

So `(def y (add x (vca y 4000)))` compiles and runs: `y` reads the previous
tick's `y` on its back-edge, scaled by a gain just under one, which is exactly
what a one-pole filter needs (`vca` is the gain, `mul` is a true product). You
can also place the delay yourself with `(z1 X)` when the placement matters:

```lisp
(def count (add (z1 count) 1))   ; each sample, count is itself plus one
```

Tape feedback is the obvious case: the dub delay writing audio into a buffer and
reading it back, the Turing machine writing each new step into the loop it read
from. That is ordinary tape semantics. Writes commit at end of tick, reads see
the previous tick's state. Between the two you get delay lines and reverbs,
resonant and self-oscillating filters (resonance is feedback), Karplus-Strong
plucks, self-mutating sequencers, anything with a loop you want to close.

## Lenses and thru

A tape on its own is a list of 12-bit values. A `lens` gives those values
meaning. It is a small codebook that maps each cell to something: a note, a
chord interval, or a function. Whether a lens carries values or functions is
decided by quoting, the same way Lisp uses quoting to split data from code.

A lens is callable as a function of its index, and `thru` is the explicit form:
`(thru list idx)` returns the `idx`-th cell. An out-of-range index wraps, which
is musical. If the cell is a value you get the value; if it is a function you
apply it with ordinary parens:

```lisp
((thru ops idx) note)   ; pick a function from ops, apply it to note
```

Lists must be homogeneous, all values or all functions, so that "apply or not"
is decidable. Symbols in a list resolve against the environment (note names,
your own `def`s); an unbound symbol is a compile error, which catches typos.

`squint` is sugar for indexing a lens by a control. It spreads the selector
across the list length so a 0..VMAX value (a knob, a switch rail) lands on a
valid cell:

```lisp
(squint '(maj3 min3 aug) (knob :x))   ; knob picks a chord
((squint ops sel) note)             ; control picks an op and applies it
```

The meta Turing machine is built on this: one tape holds a tune, another holds
a little program of note transformations, and `thru` reads the program tape and
applies whichever operation it points at:

```lisp
(def same (fn (:n) n))
(def up   (fn (:n) (transpose n 12)))
(def flip (fn (:n) (sub 120 n)))
(def down (fn (:n) (transpose n -12)))
(def ops  (lens same up flip down))     ; a lens of four functions

(def prog (tape ops '(same up flip down)))   ; a tape of their indices
(def v2   ((thru ops (step prog :trig bar)) v1))
```

The prelude ships scales and chords as lenses of semitone offsets: `minor`,
`major`, `dorian`, `chromatic` (scales), and `maj3`, `min3`, `dim`, `aug`,
`sus2`, `sus4`, `maj7`, `min7`, `dom7`, `dim7` (chords). Pair a scale with
`(snap note :scale minor)` to pin a pitch to it.

## Functions

A function in Loupe is a small module with named inputs and outputs. You declare
one the same way you declare a tape: `fn` makes the shape, `def` binds it to a
name. `def` is the only binder, and what you bind can be a tape, a function, a
clock, or any expression.

The simplest functions take inputs and return one value. The body is the
expression to return:

```lisp
(def lopass-gate (fn (:in :ping :decay)
  (lpg in (envelope :trig ping :decay decay))))
```

It is called like any builtin: `(lopass-gate (audio-in :1) (pulse-in :1) (knob :x))`.

By convention a function's **first input is its signal input**, the thing it
processes, with the rest (cutoff, amp, decay) as trailing arguments or keywords.
The builtins follow this: `lpf`, `vca`, `transpose` and `quantise` all take their
signal first. It is what lets a function sit in a cable chain: the cable threads
the running signal into each stage's first input (see The cable), so a function
whose first input is its signal drops into a chain with nothing written, while
one that takes a parameter first cannot. Put the signal first.

If a function needs more than one output, list them after `=>` and write each
one with `<-`, the same way a patch wires the card's jacks:

```lisp
(def wavefolder (fn (:in :drive :trig :steps => :out :random :clock)
  (<- out    (wavefold in drive))
  (<- random (cv (mul (spread (random :trig trig) steps) (div VMAX steps))))
  (<- clock  (toggle trig))))
```

The shape before `=>` is the input list, after it the output list. A caller
picks an output with a keyword: `(wf :random)`, `(wf :clock)`.

### Keywords and defaults

The leading colon on `:in`, `:decay`, `:scale` and so on is how Loupe writes
named arguments. You see them declared on a function's signature and used by
callers to set an argument by name: `(envelope :trig ping :decay 12)`.

A parameter can carry a default, written as the value that follows it:

```lisp
(def lopass-gate (fn (:in :ping :decay 32)   ; decay defaults to 32
  (lpg in (envelope :trig ping :decay decay))))
```

Keywords are only ever labels and argument keys. They are never runtime values;
enum-like names are plain symbols in a list, not keywords.

### Most parameters accept streams

Almost any parameter that takes a value also takes a stream: an expression that
produces a new value every sample. That is how modulation works. The thing on
the other end of the wire does not know whether it was handed a constant, a knob,
an LFO or another oscillator, because at the per-sample level they are all the
same: a value coming in.

```lisp
(lpf :in x :cut 1500)                            ; fixed cutoff
(lpf :in x :cut (knob :y))                        ; cutoff follows a knob
(lpf :in x :cut (add (knob :y) (vca lfo 800)))    ; cutoff modulated around a knob
```

### Patches and libraries

`patch` is a function whose inputs and outputs are the card's hardware: the
jacks, LEDs and panel. You do not declare its signature because the card
declares it for you. Everything else is the same: `def`s bind names, `<-`s wire
the outputs.

So a library is a file of `def`s, mostly `fn`s, that another patch can `use`:

```lisp
(use utility-pair/lopass-gate)
(use utility-pair/wavefolder)
(patch
  (<- (audio-out :1) (lopass-gate (audio-in :1) (pulse-in :1) (knob :x))))
```

From the CLI, `(use foo)` reads `foo.loupe` from the patch's own directory. From
the web editor it fetches the same file served alongside the page.
`patches/utility-pair/` is the worked example: a folder of small single-purpose
`fn` files (low-pass gate, wavefolder, sample-and-hold, slew, quantiser, and
more) plus a thin patch that wires two of them to the two halves of the
faceplate. None of the utilities are special to that patch; any patch can `use`
any of them.

## Built into the runtime versus written in Loupe

Some things you might expect to be Loupe builtins are C kernels in `runtime/`:
oscillators, filters, the wavefolder, envelopes, the drum voices, the delay-line
read. These are hot per-sample DSP, and writing them in C keeps the audio loop
fast enough to hold 48 kHz. The C runtime is the source of truth for what they
do.

The compositional work stays in Loupe: routing, gates and conditional logic,
clock derivation, anything that wires existing primitives together. The line is
pragmatic. If a function would have to run every sample and do real arithmetic,
it tends to end up in C; if it is about how things connect, it lives in Loupe.

## A couple of idioms

`random` returns the full 0..VMAX range, so `(snap (random) :scale minor)` pins
to the top note of the scale, rarely what you want. Map it into a useful range
first: `(snap (add C3 (spread (random) 25)) :scale minor)` gives two octaves of
minor-scale notes from C3.

A cable chain is the signal's spine; declare the branches as named `def`s above
it. A side-chain (an envelope feeding a vca's amp) and a signal that fans out to
two jacks are the cables that come in from the side, so naming them keeps the
chain a single clean column and a reader (including future you) can see the
shape at a glance.

The compiler removes redundancy. A constant compiles once. Anything you name
with `def` compiles once, and every reference is the same shared node. Two
identical expressions written in different places usually merge too, so you can
repeat yourself for clarity and pay no runtime cost. The exception is
pure-entropy builtins (`random`, `noise`, `walk`, `chance`) and feedback
(`feedback`, `z1`): these stay separate copies, because that is almost always
what you wanted. If you do want one shared random, name it:
`(def jitter (random))`.

## A note on bugs

The compiler is fussy about some shapes and lax about others; this is a hobby
project shared as-is. If you find something that looks wrong, it probably is.
Please report it. Have fun rummaging.
