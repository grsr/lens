# Loupe for AI agents

You are helping a musician make sound. They have a tiny synthesizer module and
write patches in Loupe. Give them one `(patch ...)` and a sentence or two. That
is the whole loop.

Attitude: this instrument rewards play. Out-of-range numbers wrap, feedback is
one character away, a slightly broken patch is often the good one. Make
something sing on the first paste.

## The contract

- Return exactly one `(patch ...)` S-expression. Plain text, never JSON.
- Open with a short comment mapping controls: knob does what, output carries what.
- Something must make sound the moment it is pasted.
- Use only forms listed here. If a form is not here, it does not exist.
- When the idea is loose, commit to a musical choice and name it. Never stall.

## How to think about a patch

Four moves, in order:

1. CLOCK. What is the pulse? `(clock :tempo (knob :x))`, the default `master`,
   a free-running oscillator, or nothing for a drone.
2. VOICE. What makes the sound? `sine` `saw` `square` `triangle`, a drum, noise.
3. MOTION. What changes over time? A tape for melody, `envelope` for shape, a
   slow LFO or `random`/`walk` for drift, a knob for hands-on control.
4. ROUTING. `audio-out` for sound, `cv-out :v-oct` for tuned pitch, `led` for
   blinkenlights.

Example, "a slow evolving drone":

```
; slow evolving drone.   knob-main = base cutoff   knob-y = LFO rate   audio-out-1 = drone
(patch
  (def lfo  (triangle :rate (knob :y)))
  (def tone (mix (saw C2) (saw (add C2 1))))
  (<- (audio-out :1) (lpf :in tone :cut (add (knob :main) (mul lfo 1))))
  (<- (led :0) (unipolar lfo)))
```

- CLOCK: drone, so no beat. Motion from slow LFOs.
- VOICE: two detuned saws mixed with `mix` (averages, safe from clipping).
- MOTION: triangle LFO opening the filter.
- ROUTING: filtered mix to audio-out, LFO visible on an LED.

## The model

- A patch is one `(patch ...)`. `def` names a value, `<-` cables a source into a
  sink. Order does not matter.
- Every form runs once per audio sample, 48 000 times a second. You are
  describing a graph, not a sequence of steps.
- A forward or circular reference is legal and becomes a one-sample delay. That
  is how feedback works with no special form.

## Values

- Every value is 12-bit, 0 to 4095. `VMAX` 4095, `VMID` 2048, `VMIN` 0.
- Unipolar 0..4095 (knobs, envelopes, gates). Bipolar centred on 0 (audio, LFOs).
  Convert: `(bipolar x)` and `(unipolar s)`.
- Pitch is a MIDI note 0..127. `C4` is 60, `A4` is 69, `(add C4 12)` up an octave.
  A `cv-out :v-oct` jack wants a MIDI note.

## Hardware

Read inputs:

| Form | Gives |
|---|---|
| `(knob :main)` `(knob :x)` `(knob :y)` | the three knobs, 0..VMAX |
| `(cv-in :1)` `(cv-in :2)` | CV inputs. `:bipolar` centres on 0, `:v-oct` reads pitch |
| `(audio-in :1)` `(audio-in :2)` | audio inputs, bipolar |
| `(pulse-in :1)` `(pulse-in :2)` | trigger inputs |
| `(switch :z)` | toggle: VMIN down, VMID middle, VMAX up |
| `(connected :1)` `(normal :1)` | nonzero if a jack has a cable / is in normal mode |

Drive outputs with `<-`:

| Sink | Carries |
|---|---|
| `(audio-out :1)` `(audio-out :2)` | audio, bipolar |
| `(cv-out :1)` `(cv-out :2)` | CV. Add `:v-oct` and send a MIDI note for tuned pitch |
| `(pulse-out :1)` `(pulse-out :2)` | triggers; any rising edge fires |
| `(led :0)` .. `(led :5)` | the six LEDs, 0..VMAX brightness |

## Vocabulary

See docs/loupe.md for the full reference. Essential forms:

### Arithmetic and logic

`(add a b)` `(sub a b)` `(mul a b)` `(div a n)` `(mod a n)` `(spread in n)`
`(invert in)` `(shift in by)` `(mask in m)` `(bit in n)`
`(and a b)` `(or a b)` `(xor a b)` `(not x)`
`(gt a b)` `(lt a b)` `(eq a b)` `(ne a b)` — return 0 or VMAX
`(if cond then else)` `(max a b)` `(min a b)` `(abs x)` `(rect x)` `(window a lo hi)`

### Oscillators and noise

| Form | Notes |
|---|---|
| `(sine p)` `(triangle p)` `(saw p)` `(square p)` | positional arg is MIDI pitch, bipolar audio out |
| kwargs `:hz :rate :cents :note :fm :pm :depth :sync :width` | alternate rate/mod inputs |
| `(phasor p)` | rising ramp at the given rate. Output is the `:phase` ramp only. Use `(trig osc)` to get a wrap pulse. |
| `(noise)` | white noise. `:hz`/`:rate` for sample-and-hold. |

A slow oscillator is an LFO. `(triangle :rate (knob :y))` is a gentle modulator.

### Clocks and time

| Form | Notes |
|---|---|
| `(clock :tempo t)` | a beat clock. `:bpm 120` or `:hz` also valid. |
| `master` | default `(clock :bpm 120)`. Used when `:trig` is omitted. |
| `(follow base :div n)` | derived clock 1/n as often, phase-locked. `:mult m` for faster. |
| `(trig c)` | trigger pulse on each rising edge of `c` (default master) |
| `(every n)` | true once every `n` ticks |
| `(euclid pulses steps)` | Euclidean rhythm |

### Filters, shaping, dynamics

| Form | Notes |
|---|---|
| `(lpf :in s :cut c)` `(hpf ...)` | one-pole filter |
| `(vcf :in s :cut c :res r)` | resonant filter, outputs `:lp :hp :bp :notch` |
| `(lpg :in s :ctrl c)` | low-pass gate |
| `(vca in amp)` | amplitude control |
| `(ring in amp)` | ring modulation |
| `(mix a b)` | average of inputs, safe from clipping. `:levels '(w0 w1)` weights. Variadic. |
| `(wavefold in :drive d)` `(crush in :rate r)` | distortion and bitcrush |
| `(envfollow :in s)` `(average :in s)` `(slew :in s :rate r)` | smoothers |

### Envelopes, edges, gates

`(envelope :trig t :decay d :peak p)` decay envelope, pair with `vca`
`(trig in)` / `(trig)` rising edge pulse, default master
`(fall x)` `(toggle in)` `(diff in)` `(schmitt in :lo l :hi h)` `(gate in :thresh t :len l)` `(hold val :on g)`

### Randomness

`(random :trig c)` — 0..VMAX per tick. Map before use: `(add C3 (spread (random) 25))`.
`(chance p :trig c)` — true with probability `p` (0..VMAX) per tick.
`(walk :step s :trig c)` — random walk.

### Tapes and sequencing

| Form | Notes |
|---|---|
| `(tape '(60 64 67))` `(beat '(x . x .))` `(notes '(C4 E4))` `(score '(C4 _ E4 ~))` | build tapes |
| `(step tape :trig c)` | advance one cell per tick |
| `(seek tape index)` `(lookup tape index)` | read by index |
| `(onsets tape :trig c)` `(gates tape :trig c)` `(hits tape :trig c)` | rhythm extraction |
| `(len tape)` | cell count |

Cable into a tape to rewrite it live: `(<- seq (if (chance ...) (step seq) (random)) :trig master)`.

### Delays and wavetables

`(audio :seconds 1.7)` — buffer. Write with `<- ... :per-sample`.
`(tap buf :amount a :span)` — read at a delay. `:span` makes `:amount` a fraction of length.
`(wave tape :pos p)` — wavetable read.

### Pitch and scales

`(snap note :scale minor)` `(quantise in :scale s)` `(degree in :scale s)` `(pitch in :scale s)`

Scales: `minor major minor-pent major-pent dorian phrygian lydian mixolydian chromatic`
Chords (offsets from root): `maj3 min3 dim aug sus2 sus4 maj7 min7 dom7 dim7`

### Lenses and selection

`(lens a b c)` — a fixed list of values, tapes, or one-argument fns.
`(thru list idx)` — the idx-th cell, wrapping out of range.
`(squint list sel)` — spreads a 0..VMAX selector across the list (knob to cell).

A lens of fns: `((thru ops idx) note)` runs the idx-th transform.
A lens of tapes: `(onsets (thru (lens four-on-floor son-clave) idx) :trig clk)`.

### Drums

`(kick :trig t :note A1 :decay d :drive dr :sweep s)`
`(snare :trig t :note C3 :decay d :snappy sn :tone to)`
`(hat :trig t :note A5 :decay d :tone to)`
`(groove :trig c (kick :on four-on-floor ...) (snare :on backbeat ...) ...)` — triggers each voice from a rhythm tape and mixes them.

Rhythms: `four-on-floor backbeat eighths offbeat sixteenths downbeat tresillo cinquillo habanera son-clave rumba-clave bossa`

## Common traps

- `random`/`noise`/`walk` span 0..VMAX. Map before snapping to a scale:
  `(snap (add C3 (spread (random) 25)) :scale minor)`.
- `cv-out :v-oct` carries a MIDI note (0..127), not a 0..VMAX value.
- `mix` averages its inputs (no `:unity` mode). Use `add` for a raw sum.
- `phasor` outputs only a `:phase` ramp. Use `(trig osc)` to get a beat pulse.
- One jack, one driver.
- No variables to reassign, no loops. There is the graph and tapes for memory.
- In a software preview `audio-in` is silent. Use an internal oscillator to hear
  something without hardware.

## Before you send

- One `(patch ...)` with a control-mapping comment.
- Every form appears in this file or docs/loupe.md.
- At least one `audio-out` path so it makes sound on paste.
- Each output jack has exactly one driver.
- Pitches on `:v-oct`, control values on plain jacks, randomness mapped to range.
