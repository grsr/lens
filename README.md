# Lens

> **Work in progress.** Lens is early and shared so people can start playing
> with it, not as a finished release. Expect rough edges, patches that
> misbehave, and plenty of outright bugs. Because Loupe is a little language
> that lets you combine things in lots of ways, testing every combination
> someone might throw at it is essentially impossible (or at least more than
> I'm prepared to do on my own ;) Releasing early is partly an attempt to
> distribute the debugging across more hands. Please try it, please report
> what you find, and please share what you make. Finding weird behaviour is half the
> fun (or that's what I think anyway!).

Lens is a program card for the [Music Thing Workshop System
Computer](https://www.musicthing.co.uk/Computer_Program_Cards/). It turns the
card into a small programmable synth: a generative voice, a sequencer, a
quantiser, a delay, a Turing machine, whatever you wire up. You write patches
in [Loupe](docs/loupe.md), a small parens-and-S-expressions language that
compiles to a graph the card runs at 48 kHz.

If you already have a card flashed with Lens, the web editor lives at
<https://grsr.github.io/lens/web/> (Chrome or Edge, WebMIDI needed). It
loads the example patches, lets you edit and send them to the card, and
saves them into flash.

Out of the box the card boots into `meta-turing-machine.loupe`. It's a take
on Tom Whitwell's Turing Machine with an extra layer: there's the usual tape of notes that slowly rewrites itself,
plus a second tape holding a stream of operations (transpose, octave, flip,
fifth) that get applied to the notes, and that tape rewrites itself too. Two
voices come out: the plain tune on `cv-out-1` + `pulse-out-1`, the tune
through the current op on `cv-out-2` + `pulse-out-2`. Knob X is tempo, main
is how often the ops mutate, Y is how often the tune does.

To hear it you need to patch the CV and pulse outs to external voices: the
CV out gives v/oct pitch, the pulse out gives a per-beat trigger. In the
Workshop System that's the two SineSquare oscillators, the two Slopes, and
the Mix. The audio outs carry bench-sine monitors of the same notes if you
just want to hear the patch in isolation first.

Here's a Turing-Machine-style note loop in Loupe: a tape of notes that
slowly rewrites itself as it plays. The `<-` line writes the result of the
`if` straight back into the same tape it came from. `tick` is a one-sample
pulse on every beat of the master clock, which is what drives the trigger
on `pulse-out-1`.

```lisp
(patch
  (def loop   (tape notes '(C3 Eb3 G3 Bb3 C4 Bb3 G3 Eb3)))
  (def master (clock :tempo knob-x))
  (<- loop (if (chance knob-main)
               (step loop)
               (snap (add 48 (spread (random) 25)) :scale minor)))
  (<- cv-out-1    (v-oct (step loop)))
  (<- pulse-out-1 (tick)))
```

`step`, `chance`, `snap`, `v-oct`, `tick`, the knob bindings: every word
above is documented in [docs/loupe.md](docs/loupe.md), which is where to
go when you want to write your own.

A patch speaks CV, gates and audio at the six jacks, so the card plays well
with the rest of the Workshop System (or the rest of your rack, if you have
the Computer as a standalone module).

## Get it onto a card

The repo ships a ready-built firmware as `lens.uf2`. Flash it the same way you
flash any other program card on the module. The simplest path:

1. Connect the module to a computer over USB.
2. Take whatever card is in the slot out.
3. Press the reload button on the module.
4. Insert a card you're happy to overwrite.
5. The card mounts as a USB drive called `RPI-RP2`. Copy `lens.uf2` onto it.

If it worked you'll see a little Lens "L" boot dance on the LEDs. After
that the card is running the meta turing machine factory patch described
above. To hear it you need the patching covered there (CV outs to
oscillator pitch, pulse outs to envelope triggers); the audio outs carry
bench-sine monitors as a fallback if you just want to confirm sound.
Holding the Z-switch down for about 5 seconds writes whatever patch is
currently running into the card's flash, so it survives a power cycle.

## Change what it does

There are two ways to send a different patch to the card.

**Web editor (no install).** Open <https://grsr.github.io/lens/web/> in
Chrome or Edge (WebMIDI is needed), click *connect*, pick an example from
the dropdown, edit, hit *send*. *Save to card* writes the patch into
flash so it survives a power cycle.

**Command line.** If you have Node:

```sh
npm install
node cli.js write patches/turing.loupe          # send a patch
node cli.js write patches/turing.loupe --save   # send and save to flash
```

`node cli.js --help` lists the rest.

## Example patches

The patches in `patches/` are starting points, not a survey of the
language. They cover a small slice of what Loupe can express. Writing
interesting patches of your own (or asking a friendly local AI coding
assistant to write some with you) is really what Lens is about.

Each example opens with a few comment lines that say what it does, what
the knobs control, and what to patch where. The `utility-pair/` subfolder
is a homage to Chris Johnson's Utility-Pair card and a good demo of the
`(use)` / library style.

Lens leans into the cerebral, generative and feedback-driven side of
modular, but it doesn't have to be used that way. It can just be a kick
drum, an oscillator, a filter, or any other single voice in your rack.
`patches/just-a-kick.loupe` is the kick version: decay, drive and pitch
sweep on the knobs, octave on the Z-switch, CV ins for pitch and decay
modulation, pulse in for trigger, kick on the audio outs, plus an inverse
amp envelope on `cv-out-2` for sidechaining.

Read [docs/loupe.md](docs/loupe.md) when you want to start writing your own.

## If you want to dig in

- [docs/loupe.md](docs/loupe.md). Loupe, the language.
- [docs/developer_guide.md](docs/developer_guide.md). How the firmware and
  compiler fit together, what runs where, how to build and modify.
- [AGENTS.md](AGENTS.md). Pointer for AI agents helping someone work on the
  card or write patches.

## Build from source (optional)

If you'd rather build the firmware yourself, you'll need the Raspberry Pi
[pico-sdk](https://github.com/raspberrypi/pico-sdk):

```sh
cd lens
cmake -B build
cmake --build build -j
```

A fresh `lens.uf2` lands at the repo root.

## Acknowledgements

Lens stands on a pile of other people's work:

- **Chris Johnson** for `ComputerCard.h`, the C++ library that talks to the
  card's hardware. Also for the band-limited sawtooth in `loupe.h`, which
  comes from his Utility-Pair card, and for the Utility-Pair card itself
  which the `patches/utility-pair/` folder is a homage to.
- **Vincent Maurer** for the ADC self-heal pattern inside `ComputerCard.h`,
  from his Grains card.
- **Émilie Gillet** and **Mutable Instruments** for Plaits, whose percussion
  voices inspired the kick, snare and hat in `loupe.h`.
- **Tom Whitwell** and **Music Thing Modular** for the Workshop System
  itself, and the Computer card this all runs on.
- **Raspberry Pi** for the [pico-sdk](https://github.com/raspberrypi/pico-sdk).

A lot of the hairier parts of the compiler and the runtime were written by
Claude Code. His human assistant did his best to follow along, takes full
responsibility for the bugs, and admits he isn't 100% sure how some of it
works ;)

I hope poking around in this is as fun and interesting for you as building
it has been for me. I've learned a lot of new things along the way and I'm
still finding new combinations the language can express. If anything in
here sparks something, I'd love to hear about it. The [Workshop System
Discord](https://discord.gg/NrfBAjfX62) is the best place to chat about
patches, swap ideas, ask questions, and hear about updates as they land.

It's a hobby project, so I can't promise quick replies. If something breaks,
please open an issue with the patch text and what you expected. The card
fails amusingly more than dangerously, so it's usually safe to just try
things. A PR with a fix is just as welcome as an issue ;)
