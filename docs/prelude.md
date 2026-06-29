---
title: prelude
description: The standard environment every patch starts with.
---

<!-- generated from prelude.loupe by tools/build_web.js; do not edit by hand -->

# Prelude

`prelude.loupe` is the standard environment every patch starts with: constants, pitch
names, helper functions, the builtin op surface, scales, chords, rhythms, and pattern
builders. Every definition here can be shadowed by redefining it in your own patch.

```clojure
; prelude.loupe -- the standard environment every patch starts with.
; Shadowable: any def here can be redefined in a patch.

; ===========================================================================
; CONSTANTS
; ===========================================================================

(def VMAX 4095)         ; 12-bit ceiling
(def VMID 2048)         ; bipolar centre / unipolar midpoint
(def VMIN 0)            ; floor
(def SMAX 2047)         ; bipolar audio peak (a signed 12-bit sample spans -SMAX..SMAX)
(def OCTAVE 12)         ; semitones per OCTAVE
(def MIDI-MAX 127)      ; top MIDI note (= G9); use (spread x (add MIDI-MAX 1)) to map a 0..VMAX control across all pitches
(def half 2048)         ; VMAX / 2
(def vmax VMAX) (def vmid VMID) (def vmin VMIN)   ; lowercase aliases

; ---- rhythm + score conventions ----
; Syms in quoted patterns env-look-up to these.
(def x    4095)         ; beat hit  (gate high)
(def .    0)            ; beat rest
(def _    0)            ; score rest (no note)
(def ~    4095)         ; score tie  (hold previous)

; ===========================================================================
; PITCH NAMES: MIDI 0..127, bound by index in chromatic order.
; C-1=0, C4=60, G9=127. Bare C4 in any expression env-looks-up to 60.
; (add C4 OCTAVE) = (add 60 12) = 72.
; ===========================================================================

(def (C-1 C#-1 D-1 D#-1 E-1 F-1 F#-1 G-1 G#-1 A-1 A#-1 B-1
      C0  C#0  D0  D#0  E0  F0  F#0  G0  G#0  A0  A#0  B0
      C1  C#1  D1  D#1  E1  F1  F#1  G1  G#1  A1  A#1  B1
      C2  C#2  D2  D#2  E2  F2  F#2  G2  G#2  A2  A#2  B2
      C3  C#3  D3  D#3  E3  F3  F#3  G3  G#3  A3  A#3  B3
      C4  C#4  D4  D#4  E4  F4  F#4  G4  G#4  A4  A#4  B4
      C5  C#5  D5  D#5  E5  F5  F#5  G5  G#5  A5  A#5  B5
      C6  C#6  D6  D#6  E6  F6  F#6  G6  G#6  A6  A#6  B6
      C7  C#7  D7  D#7  E7  F7  F#7  G7  G#7  A7  A#7  B7
      C8  C#8  D8  D#8  E8  F8  F#8  G8  G#8  A8  A#8  B8
      C9  C#9  D9  D#9  E9  F9  F#9  G9))

; flat aliases: Db=C#, Eb=D#, Gb=F#, Ab=G#, Bb=A# for every octave -1..9.
; Cb_n=B_(n-1), Fb_n=E_n for completeness.
(def Db-1 C#-1) (def Eb-1 D#-1) (def Fb-1 E-1) (def Gb-1 F#-1) (def Ab-1 G#-1) (def Bb-1 A#-1)
(def Cb0  B-1) (def Db0  C#0)  (def Eb0  D#0)  (def Fb0  E0)  (def Gb0  F#0)  (def Ab0  G#0)  (def Bb0  A#0)
(def Cb1  B0)  (def Db1  C#1)  (def Eb1  D#1)  (def Fb1  E1)  (def Gb1  F#1)  (def Ab1  G#1)  (def Bb1  A#1)
(def Cb2  B1)  (def Db2  C#2)  (def Eb2  D#2)  (def Fb2  E2)  (def Gb2  F#2)  (def Ab2  G#2)  (def Bb2  A#2)
(def Cb3  B2)  (def Db3  C#3)  (def Eb3  D#3)  (def Fb3  E3)  (def Gb3  F#3)  (def Ab3  G#3)  (def Bb3  A#3)
(def Cb4  B3)  (def Db4  C#4)  (def Eb4  D#4)  (def Fb4  E4)  (def Gb4  F#4)  (def Ab4  G#4)  (def Bb4  A#4)
(def Cb5  B4)  (def Db5  C#5)  (def Eb5  D#5)  (def Fb5  E5)  (def Gb5  F#5)  (def Ab5  G#5)  (def Bb5  A#5)
(def Cb6  B5)  (def Db6  C#6)  (def Eb6  D#6)  (def Fb6  E6)  (def Gb6  F#6)  (def Ab6  G#6)  (def Bb6  A#6)
(def Cb7  B6)  (def Db7  C#7)  (def Eb7  D#7)  (def Fb7  E7)  (def Gb7  F#7)  (def Ab7  G#7)  (def Bb7  A#7)
(def Cb8  B7)  (def Db8  C#8)  (def Eb8  D#8)  (def Fb8  E8)  (def Gb8  F#8)  (def Ab8  G#8)  (def Bb8  A#8)
(def Cb9  B8)  (def Db9  C#9)  (def Eb9  D#9)  (def Fb9  E9)  (def Gb9  F#9)

; ===========================================================================
; HELPER FNS (composed from primitives)
; ===========================================================================

; value (0..VMAX) -> bipolar (-VMAX..+VMAX) signal.
(def bipolar  (fn (:x) (sub (mul x 2) VMAX)))

; bipolar (-VMID..+VMID) signal -> value (0..VMAX).
(def unipolar (fn (:s) (add s VMID)))

; ---- jack-boundary conversions ----
; signed: identity for audio jacks (DAC accepts signed bipolar samples).
(def signed     (fn (:x) x))
; brightness: identity for LEDs (PWM accepts 0..VMAX directly).
(def brightness (fn (:x) x))

; absolute distance between two values.
(def dist     (fn (:a :b) (abs (sub a b))))

; hard-clip a signal to the bipolar audio rails (use before an audio-buffer
; write: the buffer wraps rather than clamps, so an over-range value flips
; polarity and crackles). For a soft knee use `saturate` instead.
(def clip     (fn (:in) (min (max in (sub 0 SMAX)) SMAX)))


; ===========================================================================
; SCALES (semitone offsets from a root)
; ===========================================================================

(def minor      (lens '(0 2 3 5 7 8 10)))
(def major      (lens '(0 2 4 5 7 9 11)))
(def minor-pent (lens '(0 3 5 7 10)))
(def major-pent (lens '(0 2 4 7 9)))
(def dorian     (lens '(0 2 3 5 7 9 10)))
(def phrygian   (lens '(0 1 3 5 7 8 10)))
(def lydian     (lens '(0 2 4 6 7 9 11)))
(def mixolydian (lens '(0 2 4 5 7 9 10)))
(def chromatic  (lens '(0 1 2 3 4 5 6 7 8 9 10 11)))

; 12-bit pitch-class masks per scale; pair with (snap :scale ...).
(def scale-masks (lens '(1453 2741 1193 661 1709 1451 2773 1717 4095)))

; ===========================================================================
; BUILTINS -- primitive ops the runtime implements directly.
; Empty fn body = a primitive implemented by a C kernel of the same name.
; The params list the full call surface.
; ===========================================================================

; ---- value arithmetic ----------------------------------------------------
; add/sub take :sat to saturate at the value rails instead of wrapping.
(def add       (fn (:a :b :sat)))
(def sub       (fn (:a :b :sat)))
(def mul       (fn (:a :gain)))
; div floors and mod takes the divisor's sign, so (div a n)*n + (mod a n) = a.
(def div       (fn (:a :n)))
(def mod       (fn (:a :n)))
(def transpose (fn (:in :by)))
(def invert    (fn (:in)))
(def spread    (fn (:in :n)))
(def shift     (fn (:in :by)))
(def mask      (fn (:in :mask)))
(def bit       (fn (:in :n)))
(def xor       (fn (:a :b)))
(def and       (fn (:a :b)))
(def or        (fn (:a :b)))

; ---- comparisons (return 0 or VMAX) --------------------------------------
(def gt  (fn (:a :b)))
(def gte (fn (:a :b)))
(def lt  (fn (:a :b)))
(def lte (fn (:a :b)))
(def eq  (fn (:a :b)))
(def ne  (fn (:a :b)))

; ---- panel / jack leaves -------------------------------------------------
; Uniform call-form: (name :label [:interpretation...]). Every read is 0..VMAX.
; (knob :main) detents the rails (half-width 96); :detent 0 reads raw.
; (cv-in :1) is unipolar 0..VMAX; :bipolar centres on 0; :v-oct reads pitch.
; (switch :z) returns the rails VMIN/VMID/VMAX (down/middle/up).
(def knob     (fn (:main :x :y :detent)))
(def cv-in    (fn (:bipolar :v-oct)))
(def pulse-in (fn ()))
(def audio-in (fn ()))

; ---- MIDI input ----------------------------------------------------------
; From a USB keyboard plugged into the card (host) or a computer (device).
; Same (name :label) form; :ch picks a channel 1..16 (omitted = omni). midi-note
; and midi-velocity hold the last note-on; (midi-cc :N) reads CC number N;
; midi-trig fires on note-on of :note; midi-clock/midi-playing follow transport.
(def midi-note     (fn (:ch)))
(def midi-gate     (fn (:ch :note)))
(def midi-velocity (fn (:ch)))
(def midi-bend     (fn (:ch)))
(def midi-pressure (fn (:ch)))
(def midi-trig     (fn (:note)))
(def midi-cc       (fn ()))
(def midi-clock    (fn ()))
(def midi-playing  (fn ()))

; ---- oscillators ---------------------------------------------------------
(def phasor   (fn (:pitch :hz :rate :tempo :cents :sync :fm :depth :width => :phase)))
(def sine     (fn (:pitch :note :midi :fm :pm :depth :fb :sync :hz :rate :cents :phase)))
(def triangle (fn (:pitch :note :midi :fm :pm :depth :sync :hz :rate :cents :phase)))
(def saw      (fn (:pitch :note :midi :fm :pm :depth :sync :hz :rate :cents :phase)))
(def square    (fn (:pitch :note :midi :fm :pm :depth :sync :hz :rate :width :cents :phase)))
(def wavetable (fn (:table :pitch :pos :pm :hz :rate :cents => :out)))
(def wt        (fn (:table :pitch :pos :pm :hz :rate :cents => :out)))
(def follow   (fn (:base :mult :div :rate :drift)))

; ---- audio shaping -------------------------------------------------------
(def average  (fn (:in :cut)))
(def lpf      (fn (:in :cut :poles :hz)))
(def hpf      (fn (:in :cut :poles :hz)))
(def lpg      (fn (:in :ctrl)))
(def envfollow (fn (:in :cut)))
(def vcf      (fn (:in :cut :res => :lp :hp :bp :notch)))
(def lpf2     (fn (:in :cut :res)))
(def hpf2     (fn (:in :cut :res)))
(def bpf2     (fn (:in :cut :res)))
(def envelope (fn (:trig :gate :decay :peak)))
(def adsr (fn (:gate :attack :decay :sustain :release :peak)))
(def dxeg (fn (:gate :r1 :r2 :r3 :r4 :l1 :l2 :l3 :l4)))
(def dx   (fn (:bank :preset :pitch :gate :decay :tone => :out)))
(def slew     (fn (:in :rate)))
(def vca      (fn (:in :amp)))
(def ring     (fn (:in :amp)))
; average of its inputs (safe, can't clip). :levels '(w0 w1 ...) weights them,
; normalised to the weight sum. For a unity-gain sum use `add` instead.
(def mix      (fn (:a :b :levels)))
(def wavefold (fn (:in :drive)))
(def crush    (fn (:in :rate)))
; cubic soft-clip. :drive pre-gains into the curve, :bias (bipolar) skews it for
; even-harmonic warmth, :mix blends dry/wet, :level is output makeup gain.
(def saturate (fn (:in :drive :bias :mix :level)))
; LUT waveshaper. :drive pre-gains into a baked transfer curve; :curve picks it
; (0 soft, 1 hard, 2 asym/even-harmonic, 3 overdrive); :oversample 1 turns on 4x
; anti-aliasing (off by default). Complements saturate/wavefold/crush.
(def shape    (fn (:in :drive :curve :oversample)))

; ---- generators ----------------------------------------------------------
(def noise   (fn (:hz :rate)))
(def random  (fn (:shape :trig)))
(def chance  (fn (:p :trig)))
(def walk    (fn (:step :trig)))

; ---- edge detectors / clock state ----------------------------------------
; hold -- a sample & hold (expander form, see the stateful-memory note below).
(def hold    (fn (:val :on)))
(def pickup  (fn (:value :on :init :near)))
(def toggle  (fn (:in)))
(def schmitt (fn (:in :lo :hi)))
(def gate    (fn (:in :thresh :len)))
; a clock is just a phasor (a phase ramp) named for timebase intent. Rate kwargs and
; :sync forward to the phasor; unset ones drop. A consumer edge-detects the ramp.
(def clock   (fn (:tempo :hz :bpm :rate :width :sync)
  (phasor :tempo tempo :hz hz :bpm bpm :rate rate :width width :sync sync)))

; the master clock every CLK_OP defaults to. Defined after clock/phasor.
(def master (clock :bpm 120))
(def z1      (fn (:x)))

; varispeed: a 0..VMAX knob mapped to a play speed, sweeping from a slow LFO up to
; audio rate. Feed it to play/loop as the speed for a one-knob LFO-to-wavetable read.
; (2801 is the safe top of the phasor :rate input; spread maps the knob into [0, 2801).)
(def varispeed (fn (:knob) (spread knob 2801)))
(def feedback (fn ()))
(def diff    (fn (:in)))
; trig: a clock's BEAT = the phase wrap (the ramp's reset). Lands on the downbeat for
; any division/multiplication. No :trig -> defaults to master (CLK_OPS injection).
(def trig    (fn (:trig)))
(def turns   (fn (:trig)))
; edge: a RISING edge of a signal (a pulse arriving, a comparison becoming true).
(def edge    (fn (:in)))
; fall: a FALLING edge of a signal.
(def fall    (fn (:x)))
(def detent  (fn (:x :width)))
(def range   (fn (:in :to-index :to-value)))
(def every   (fn (:n)))
(def euclid  (fn (:pulses :steps :trig)))
(def groove  (fn (:pattern :trig)))

; ---- tape heads ----------------------------------------------------------
; Cable form: (<- SINK SOURCE [:trig C] [:per-sample] [:len L] [:when G] [:blend F])
;   :trig C      drives the recordhead's clock from C; default = master.
;   :per-sample  head writes one cell per audio sample.
;   :len L       caps the head's cycle length (literal int or stream).
;   :when G      only write while G is nonzero.
;   :blend F     fn (:old :new) -> :result for compositing into existing cells.

(def lookup  (fn (:tape :index :len)))
(def step    (fn (:tape :trig :len)))
(def seek    (fn (:tape :index :trig :len)))
(def len     (fn (:tape)))
(def counter (fn (:bars :trig)))
(def wave    (fn (:tape :note :midi :pos :once :slots :pick :scan :interp :reverse :expand :len)))
(def tap     (fn (:tape :amount :span :interp)))
(def record  (fn ()))

; play / loop: read a tape under a play head moving at `speed`, hiding the phasor.
; A play head is a phasor swept across the tape; `speed` sets how fast (and, signed,
; which way). play sweeps the whole tape; loop sweeps only the first `span` cells
; (e.g. the part of a slot actually recorded). Several plays on one tape at different
; speeds give several heads at once.
(def play (fn (:tape :speed) (lookup tape (spread (phasor :rate speed) (len tape)))))
(def loop (fn (:tape :speed :span) (lookup tape (spread (phasor :rate speed) span))))

; ---- compiler special forms ----------------------------------------------
; Handled by the expander/lowerer (no kernel of their own); listed here so the
; surface is discoverable from this file.
(def tape      (fn (:pat)))                       ; sequence buffer from a quoted list
(def audio     (fn (:seconds)))                   ; blank audio buffer of :seconds
(def score     (fn (:pat => :notes :rhythm)))     ; quoted melody -> pitch + gate tapes (_ rest, ~ tie)
(def morph     (fn ()))                           ; variadic crossfade across inputs by a position
(def normal    (fn (:jack :default)))             ; the jack when patched, else default
(def connected (fn (:jack)))                      ; VMAX if a cable is patched into the jack, else 0

; ---- hold (state / sample & hold) + timing regions ----------------------
; hold is a sample & hold. Three shapes, told apart by whether it carries a clock:
;   (hold VAL ON) | (hold VAL :on G)        level S&H: track VAL while the gate is high
;   (hold NAME NEXT :trig C | :per-sample [:init V])
;       a register/fold -- NAME is the held value, NEXT is stored each clock edge (or
;       sample) and may reference NAME for feedback (counters, accumulators, one-poles).
;   (hold VAL :trig C | :per-sample [:init V])   edge/per-sample S&H of an outside VAL.
;     (def i   (hold n (mod (add n 1) 16) :trig clk))   ; counts 0..15, one per tick
;     (def sum (hold s (add s x) :trig clk))            ; running total
; State lives in `hold`; `def` stays a timeless binding.
; (on CLK :when G FORM...)
;   A timing region: every (<- ...) write inside defaults to :trig CLK and :when G,
;   so the clock and gate are stated once, not repeated on every line.

; ---- selectors / converters ---------------------------------------------
; (switch :z) reads the panel z-switch as rails (VMIN/VMID/VMAX). Panel INPUT only.
; To select a value, use (thru (lens a b ...) idx) for index or (if cond a b) for boolean.
(def switch   (fn (:z)))

; switch (and any 3-rail control) position as a boolean: down < middle < up.
(def up   (fn (:x) (gt x VMID)))
(def mid  (fn (:x) (eq x VMID)))
(def down (fn (:x) (lt x VMID)))
(def v-oct    (fn (:note)))
(def cv       (fn (:in :bipolar)))
(def snap     (fn (:note :scale)))
(def quantise (fn (:in :scale)))
(def degree   (fn (:in :scale)))
(def pitch    (fn (:in :scale)))
; (thru LIST IDX) -> the IDX-th cell of LIST (out-of-range IDX wraps).
; A value cell IS the value; an op-lens cell is a fn you apply: ((thru ops IDX) X).
(def thru     (fn (:list :at)))
; squint: like thru but spreads the selector across the list length, so a
; 0..VMAX control (knob, switch rail) lands on a valid cell. ((squint ops sel) x).
(def squint   (fn (:lens :selector) (thru lens (spread selector (len lens)))))

; ---- value / logic sugar ------------------------------------------------
(def if     (fn (:cond :then :else)))
(def not    (fn (:x)))
(def max    (fn (:a :b)))
(def min    (fn (:a :b)))
(def window (fn (:a :lo :hi)))
(def abs    (fn (:x)))
(def rect   (fn (:x)))
; exp2: exponential CV/VCA transfer over ~8 octaves. :in 0..VMAX maps to
; VMAX*2^(8*(in/VMAX-1)): in=VMAX -> VMAX (unity), in=0 -> ~16 (near silence).
(def exp2   (fn (:in)))
; log2: inverse of exp2, recovers the linear control from the exponential gain.
(def log2   (fn (:in)))

; ---- onset/gate/hit readers over a tape ---------------------------------
(def onsets (fn (:tape :trig)))
(def gates  (fn (:tape :trig)))
(def hits   (fn (:tape :trig)))

; ---- drum primitives ----------------------------------------------------
(def kick  (fn (:note :midi :decay :drive :sweep :trig)))
(def snare (fn (:note :midi :decay :snappy :tone :trig)))
(def hat   (fn (:note :midi :decay :tone :trig)))

; Karplus-Strong plucked string: :trig re-excites, :pitch (MIDI) sets the
; loop length, :damp (0..vmax) sets decay/brightness (more = faster, duller).
(def pluck (fn (:trig :pitch :damp)))

; ===========================================================================
; PATTERN BUILDERS -- write rhythms and melodies as quoted lists.
; ===========================================================================
; (beat '(x . x .))         -> tape of gate values
; (notes '(C4 E4 G4 B4))    -> tape of MIDI pitches
; (score '(C4 _ E4 ~))      -> pitch tape + gate tape; _ rests, ~ ties

(def beat  (fn (:pat) (tape pat)))
(def notes (fn (:pat) (tape pat)))
; score is an expander form: a quoted list becomes a pitch tape and a
; rhythm tape. _ and ~ are rests; distinct ties are not yet implemented.

; midi-score: the played-in counterpart to score. Records the MIDI keyboard's
; note + gate + velocity onto a clock grid while :rec is held (the loop is as long
; as you held it), then loops the take at :speed. Returns the same :notes / :rhythm
; ports score does, plus :vel -- so a performance is consumed like a written part.
(def midi-score (fn (:rec :clk :speed => :notes :rhythm :vel)
  (def np (tape :len 1600)) (def gp (tape :len 1600)) (def vp (tape :len 1600))
  (def cap (sub (len np) 1))
  (def pos (hold p (if rec (min (add p 1) cap) 0) :trig clk))
  (def lng (hold l (if rec (add pos 1) l) :trig clk :init 1))
  (on clk :when rec
    (<- (np pos) (midi-note))
    (<- (gp pos) (midi-gate))
    (<- (vp pos) (midi-velocity)))
  (<- notes  (if rec (midi-note)     (loop np speed lng)))
  (<- rhythm (if rec (midi-gate)     (loop gp speed lng)))
  (<- vel    (if rec (midi-velocity) (loop vp speed lng)))))

; ===========================================================================
; RHYTHMS -- classic patterns to start from and mutate.
; ===========================================================================
; Step or onset over any of these. Rewrite cells via a chance-gated cable
; to drift into nearby rhythms while keeping the family.

; quarter notes (kick).
(def four-on-floor (beat '(x . . . x . . . x . . . x . . .)))

; snare backbeat (2 and 4).
(def backbeat      (beat '(. . . . x . . . . . . . x . . .)))

; eighth notes (hat).
(def eighths       (beat '(x . x . x . x . x . x . x . x .)))

; off-beat eighths.
(def offbeat       (beat '(. . x . . . x . . . x . . . x .)))

; sixteenth notes.
(def sixteenths    (beat '(x x x x x x x x x x x x x x x x)))

; downbeat only.
(def downbeat      (beat '(x . . . . . . . . . . . . . . .)))

; 3-3-2 tresillo over 8.
(def tresillo      (beat '(x . . x . . x .)))

; 2-1-2-1-2 cinquillo over 8.
(def cinquillo     (beat '(x . x x . x x .)))

; afro-cuban habanera over 8.
(def habanera      (beat '(x . . x x . . .)))

; 3-2 son clave over 16.
(def son-clave     (beat '(x . . x . . x . . . x . x . . .)))

; 3-2 rumba clave over 16.
(def rumba-clave   (beat '(x . . x . . . x . . x . x . . .)))

; bossa nova clave over 16.
(def bossa         (beat '(x . . x . . x . . . x . . x . .)))

; ===========================================================================
; SCALES + CHORDS by name (handy in patches without writing intervals)
; ===========================================================================
; Each is a lens whose cells are semitone offsets from the root.
; Pair with `(transpose root degree)` or `(add root (thru chord idx))`.
; The triads carry the note count (maj3/min3) so they don't shadow the min/max
; operators or the major/minor scales above.

(def maj3  (lens '(0 4 7)))
(def min3  (lens '(0 3 7)))
(def dim   (lens '(0 3 6)))
(def aug   (lens '(0 4 8)))
(def sus2  (lens '(0 2 7)))
(def sus4  (lens '(0 5 7)))
(def maj7  (lens '(0 4 7 11)))
(def min7  (lens '(0 3 7 10)))
(def dom7  (lens '(0 4 7 10)))
(def dim7  (lens '(0 3 6 9)))
```
