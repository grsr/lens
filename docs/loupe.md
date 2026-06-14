# Loupe

Loupe is the language you write patches in for the Lens card. The syntax is
Lisp-flavoured, because nested parens turned out to be a clean way to write a
patch in text. The compiler wires the patch up; the runtime walks the wires
48,000 times a second, and the values that fall out drive the jacks.

One thing is genuinely Lisp-spirited: a `lens` is a small codebook that gives
meaning to the tokens on a tape. The tokens can be data (notes, numbers) or
references to functions already defined, and which one they are is decided by
quoting, the same way Lisp uses quoting to split data from code. So a tape can
hold a tune, a chord progression, or a little program the runtime applies as it
plays.

This is enough to get you started. It is not a complete reference; the truth is
the compiler (`compile.js`) and the runtime (`loupe.h`). When something here
disagrees with them, the code is right.

## A patch

A patch is one S-expression. The simplest one plays a sine on the first audio
output:

```lisp
(patch
  (<- audio-out-1 (sine :note A4)))
```

Two parts: things you name (with `def`), and cables (with `<-`) that wire things
into the card's outputs.

```lisp
(patch
  (def melody (tape notes '(C3 Eb3 G3 Bb3)))
  (def clk    (clock :tempo knob-x))
  (<- cv-out-1    (v-oct (step melody :clk clk)))
  (<- pulse-out-1 (tick clk)))
```

You can look at the patches in `patches/` for more shapes. `hello.loupe`,
`turing.loupe` and `dubdelay.loupe` are good starting points.

## The cable

`<-` is the only way to send something to a sink (a jack, an LED, a tape, an
output of a function you defined). It reads sink-first:

```lisp
(<- audio-out-1 (vca env) (lpf 1500) osc)
```

means: into `audio-out-1` goes the audio from `osc`, run through
`lpf 1500`, then through `vca env`. The sink is on the left, the source
is on the right, and the stages in between read from the source end. As
nested function calls the same line would be `(vca (lpf osc 1500) env)`;
the cable form is that expression unfolded into a flat line, which scales
to long signal chains much more comfortably than nested parens.

There's no `->`. There's no shorthand. If a line wires something into a sink,
it starts with `<-`.

## Values

Everything in Loupe is a 12-bit value (0..4095), because that's what the card's
hardware naturally deals in: the ADC reads in 12 bits, the DAC writes out 12
bits, so a value at rest is just what the jacks and panel give and take. A jack
then decides what the value means: `audio-out-1` reads it as a sample,
`cv-out-1` as a voltage, `pulse-out-1` as a gate (high above the midpoint). The
same value driving two different jacks does two different things.

That means you don't have separate "audio" and "control" worlds; you have one
domain, and the consumer decides. An oscillator can be modulated by a slow
phasor; a tape of notes can drive a pitch jack or a gate jack; an envelope can
shape audio or open a filter.

There are three handy constants always in scope: `vmin` (0), `vmid` (2048),
and `vmax` (4095). You'll see them in patches as shorthand for "off",
"middle", "full".

## Builtins

This is a starting handful, not a reference. There are more, they're being
added to, and the truth is always the code: each builtin is documented at
its definition in `compile.js` and `loupe.h`.

- **Oscillators:** `sine`, `triangle`, `saw`, `square`, `phasor`, `noise`.
- **Tapes (memory):** `tape`, `audio` (an audio buffer), `step` (read one cell
  per clock tick), `seek` (read at an explicit index), `wave` (play a tape as a
  sample / wavetable), `tap` (read behind an audio buffer's write head: a delay).
- **Clocks and time:** `clock` (the master), `follow` (a derived clock at a
  ratio), `tick` (the rising edge of a clock), `every` (a divider).
- **Filters and shaping:** `vcf` (resonant SVF, lp/bp/hp/notch), `lpf`/`hpf`,
  `average` (one-pole), `slew`, `wavefold`, `crush`, `dither`.
- **Envelopes and VCAs:** `envelope`, `vca`, `ring`.
- **Pitch:** `v-oct`, `snap`, `transpose`, `degree`.
- **Logic and gates:** `if`, `chance`, `edge`, `toggle`, `schmitt`, `hold`,
  `euclid`.
- **Random:** `random`, `walk`, `spread`.
- **Routing:** `mix`, `switch`, `morph`, `arrange`.

Most builtins take keyword args (`:rate`, `:clk`, `:scale`, etc.) on top of
positional ones. If you pass an unknown keyword, the compiler error message
names the keywords that builtin actually accepts, which is usually faster
than scrolling through this guide.

## Phasors

A phasor is a ramp that goes from 0 up to its top and wraps back, over and over.
It's the engine inside every oscillator and also the engine inside every clock,
which is one of the things Loupe takes seriously: a slow phasor is a clock, a
fast one is an oscillator, and there's no real boundary in between. A clock at
the audio rate is an oscillator. An oscillator slowed to one cycle per beat
becomes a clock. The same builtin, `phasor`, makes both.

You usually don't write `phasor` directly: `(clock :tempo knob-x)` and
`(sine :note A4)` both build one for you under the hood. But knowing it's the
same thing explains why you can ride either one through `follow` to get a
locked or drifting ratio, or read either one's phase with `spread` to walk a
tape.

## Tapes and clocks

A tape is a list of 12-bit values. You can author it (`(tape notes '(C3 D3 ...))`),
generate it from a constant expression, or let a `<-` write into it live: writing
into a tape from a live stream is how the Turing machine in `patches/turing.loupe`
mutates its loop.

A tape doesn't have to be seeded with anything: `(audio :seconds 1.5)`
declares an empty buffer that's a 1.5-second blank tape, ready to be written
into. That's how the dub delay works: the tape is empty, a `<-` cable feeds
audio into it on every sample, and `tap` reads behind the write head to give
you the delayed signal. An audio sample is just a 12-bit value like any
other, so a tape doesn't really know whether it's holding notes, control
values, or audio. There are a few builtins that make audio-ish patching
easier (`wave` plays a tape as a sample or wavetable, `tap` reads behind a
write head as a delay), but underneath they're all the same tape. I'm hoping
there's a lot of mileage in treating audio as data, and other data as audio:
feeding a melody tape into `wave` as a wavetable, sampling a live audio
stream and stepping through it as a sequence, recording control values and
playing them back at audio rate. That sort of thing.

The card has 128 KB of RAM total for everything that lives in a tape, which
is not much. Long samples and long delays compete with everything else for
memory, and you'll hit the ceiling fast. Treat that as a fun constraint.

A clock is just a slow phasor with a tick. `(clock :tempo knob-x)` is the
master; most readers (`step`, `tap`, `wave`) take a `:clk` arg that defaults
to master. Want two parts in unison but the second a quarter as fast? Give it
`(follow master :div 4)` as its clock. `tick` is the rising edge of a clock,
defaulting to the master clock if you don't pass one (so `(tick)` and
`(tick master)` are the same; pass a different clock to get its edge
instead). `every` divides one.

## Feedback (the stranger thing)

A useful way to picture it: every node in Loupe has its own one-sample
tape built in, holding what the node produced last sample. Reading any
value reads that one-sample-old version, never the in-flight one. So
when a node refers to itself, it's just reading its own one-sample tape:
"me, one sample ago." DSP folk will recognise this as the z^-1 of every
IIR filter and delay line, applied uniformly.

The explicit-tape kind of feedback (the dub delay writing audio into a
buffer and reading it back via `tap`, the Turing machine writing each
new step into the same loop it read from) is the obvious case. The
per-node, per-sample kind is the same idea zoomed in: any expression
can reference itself, and it just reads its previous output. Smallest
possible example:

```lisp
(def count (feedback c (add c 1)))   ; each sample, c is itself plus one
```

`c` reads its own value from the previous sample, adds 1, that's the
new `c`. So it counts up by one per sample. Swap the `add c 1` for
something musical and you have a one-pole filter, or a phasor, or a
self-oscillating loop.

That gives you the usual set of things: delay lines and reverbs,
resonant filters and self-oscillating voices (resonance IS feedback),
Karplus-Strong plucks (a noise burst through a delay with damping),
self-mutating sequencers, anything with a loop you want to close.

## Lenses and thru

A tape on its own is just a list of 12-bit values. A `lens` is what gives
those values meaning. It's a small codebook that maps each cell to something more
useful: a note, a chord, a function. The built-in `notes` lens turns a number
into a pitch, which is why `(tape notes '(C3 Eb3 G3 Bb3))` works.

You can also build a lens out of functions you've defined, and then use
`thru` to apply the function picked by the cell. That's the trick
`meta-turing-machine.loupe` is built on:

```lisp
(def same  (fn (:n) n))
(def oct   (fn (:n) (transpose n 12)))
(def flip  (fn (:n) (sub 120 n)))
(def fifth (fn (:n) (transpose n 7)))
(def ops   (lens same oct flip fifth))       ; the lens lists four functions

(def prog (tape ops '(same oct flip oct)))   ; a tape that stores their indices
...
(def v2 (thru ops (step prog :clk bar) v1))  ; pick a function from prog, apply to v1
```

So one tape holds the tune, another tape holds a little program of
transformations, and `thru` reads the program tape and applies whichever
operation it points at to each note as it goes. Whether a lens carries
values or function references is decided by quoting, the same way Lisp uses
quoting to separate data from code.

## Functions

A function in Loupe is a little module with named inputs and outputs. You
declare a function the same way you declare a tape: `fn` makes the function
shape, `def` binds it to a name, exactly like `tape` makes a tape and `def`
names it. `def` is the only binder, and what you bind to a name can be a
tape, a function, a clock, or any other expression.

The simplest functions take some inputs and return one value. The body is
just the expression to return:

```lisp
(def lopass-gate (fn (:in :ping :decay)
  (lpg in (envelope :trig ping :decay decay))))
```

That's a function called `lopass-gate` with three named inputs (`in`, `ping`,
`decay`), and its body builds a low-pass gate from them. It's called like any
other builtin: `(lopass-gate audio-in-1 pulse-in-1 knob-x)`.

If a function needs more than one output, list them after `=>`, then write
each one into its named output with `<-`, the same way a patch wires the
card's jacks:

```lisp
(def wavefolder (fn (:in :drive :trig :steps => :out :random :clock)
  (<- out    (wavefold in drive))
  (<- random (cv (mul (spread (random :clk trig) steps) (div vmax steps))))
  (<- clock  (toggle trig))))
```

The shape before `=>` is the input list; after `=>` is the output list.
Callers pick a particular output with a keyword: `(wf :random)`, `(wf :clock)`.

### Keywords and defaults

The leading colon on `:in`, `:decay`, `:scale`, `:tempo` and so on is just how
Loupe writes named arguments. You see them on both sides of the language:
declared on a function's signature, and used by callers to set a particular
argument by name. `(envelope :decay 32)` and `(envelope :trig ping :decay 12)`
both work; the keyword tells the builtin which slot you mean.

A parameter in an `fn` signature can carry a default value, written as the
value that follows it:

```lisp
(def lopass-gate (fn (:in :ping :decay 32)   ; decay defaults to 32 if not passed
  (lpg in (envelope :trig ping :decay decay))))
```

Callers can then omit `:decay` and get 32, or pass `:decay 64` to override it.

### Most parameters accept streams

Almost any parameter that takes a value will also take a stream: an
expression that produces a new value every sample. That's how modulation works
in Loupe. The thing on the other end of the wire doesn't know whether it was
handed a constant, a knob reading, an LFO, or another oscillator, because at
the per-sample level they're all the same: a value coming in.

```lisp
(lpf in 1500)                            ; fixed cutoff
(lpf in knob-y)                          ; cutoff follows a knob
(lpf in (add knob-y (mul lfo 800)))      ; cutoff modulated by an LFO around a knob
```

The builtin's documentation says which arguments work this way. In practice
it is most of them.

`patch` is just a function whose inputs and outputs are the card's hardware:
the jacks, LEDs and panel controls. You don't declare its signature because
the card declares it for you. Everything else is the same: `def`s bind names,
`<-`s wire things into the outputs.

That means a library is simply a file of `def`s, mostly `fn`s, that another
patch can `(use)`:

```lisp
(use lopass-gate)
(use wavefolder)
(patch
  (<- audio-out-1 (lopass-gate audio-in-1 pulse-in-1 knob-x)))
```

From the CLI, `(use foo)` reads `foo.loupe` from the patch's own directory.
From the web UI, it fetches over same-origin HTTP from `patches/`, so user-
typed `(use)` resolves to files served alongside the page.

For a worked-through example of this style, look at `patches/utility-pair/`.
It's after Chris Johnson's Utility-Pair card for the Workshop System: a folder
of small `fn` files, each one a single utility (low-pass gate, wavefolder,
sample-and-hold, slew, etc.), and a thin `pair.loupe` that wires two of them to
the two halves of the card's faceplate. I used it as a way to push on Loupe
and check it could express enough useful things; some of them, like the
wavefolder, ended up implemented in C in the runtime rather than in Loupe (see
below). None of those utilities are special to that patch though, they're just
`fn`s in files: any patch can `(use)` any of them and combine them however it
likes.

## Built into the runtime vs written in Loupe

Some things you might expect to be Loupe builtins are actually C kernels inside
`loupe.h`: oscillators, filters, the wavefolder, envelopes, the drum voices,
the delay-line read. These are hot per-sample DSP, and writing them in C
keeps the audio interrupt fast enough to stay at 48 kHz.

The compositional stuff stays in Loupe: routing, gates and conditional logic,
clock derivation, anything that wires existing primitives together. The line
between the two is mostly pragmatic. If a function would have to run on every
sample and do real arithmetic, it tends to end up in C; if it's about how
things are connected, it lives in Loupe.

## A couple of idioms worth knowing

`random` returns the full 0..vmax range, so `(snap (random) :scale minor)`
pins to the top note of the scale, which is rarely what you want. Map random
into a useful range first: `(snap (add 48 (spread (random) 25)) :scale minor)`
gives you two octaves of minor-scale notes starting at C3.

Long signal chains in `<-` are clearer if you break them up with `def`s
and give the intermediates names. Nothing stops you writing a six-stage
cable, but a reader (including future you) will thank you for naming the
envelope, the filtered tone, and the gated output as their own bindings.

The compiler tries to be clever about removing redundancy. A constant
compiles once. Anything you name with `def` compiles once, and every
reference to the name is that same shared node. Two identical expressions
written textually in different places usually merge into a single node
too. So you can repeat yourself for clarity and pay no runtime cost.

One exception worth knowing about: pure-entropy builtins (`random`,
`noise`, `walk`, `chance`) and feedback builtins (`feedback`, `z1`) stay
separate copies when you write them in two places, because that's almost
always what you actually wanted. If you DO want one shared random across
the patch, name it: `(def jitter (random))`. That's the whole story, and
it's the aspiration anyway ;)

## A note on bugs

The compiler is fussy about some shapes and lax about others; this is a hobby
project shared as-is. If you find something that looks wrong, it probably is.
Please report it.

Have fun rummaging.
