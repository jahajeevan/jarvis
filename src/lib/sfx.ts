/**
 * Sound design.
 *
 * Every cue is synthesised in Web Audio rather than shipped as a file, so the
 * app makes the right noises the moment you clone it — nothing to download, no
 * licence to worry about, a few hundred bytes instead of a few megabytes.
 *
 * To use real recordings instead, drop matching files into `public/audio/`
 * (boot.mp3, wake.mp3, listen.mp3, tool.mp3, done.mp3, error.mp3) and they take
 * over automatically. Pixabay's sci-fi UI and HUD packs are the usual source —
 * CC0, no attribution, safe on a monetised channel. `ambient.mp3` is not one of
 * these: the looping bed is music.ts's, and the oscillator pair at the bottom of
 * this file is only the fallback for when that file isn't there.
 */

type Cue = 'boot' | 'wake' | 'listen' | 'tool' | 'done' | 'error'

let ctx: AudioContext | null = null
let master: GainNode | null = null
const samples = new Map<Cue, AudioBuffer>()
let ambient: { source: AudioBufferSourceNode; gain: GainNode } | null = null

/** Where the master sits when JARVIS isn't speaking. */
let volume = 0.5
let ducked = false
/** How far everything this module makes drops under the voice. */
const DUCK = 0.45

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.gain.value = volume
    master.connect(ctx.destination)
  }
  return ctx
}

/**
 * Ramp a gain to a new value from wherever it actually is.
 *
 * The cancel-then-anchor dance is not optional: a Web Audio ramp interpolates
 * from the *previous scheduled event*, so a later automation point that hasn't
 * fired yet — the three-second fade-in of the bed, say — survives, and the
 * value climbs back to it the moment the new ramp lands. That is how ducking
 * during the first seconds of the bed used to undo itself.
 */
function rampTo(param: AudioParam, to: number, seconds: number) {
  if (!ctx) return
  const now = ctx.currentTime
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(Math.max(0.0001, to), now + seconds)
}

/**
 * Browsers won't start audio until the user has interacted with the page, so
 * this has to be called from a click or keypress.
 */
export async function unlockAudio(): Promise<void> {
  const c = audio()
  if (c.state === 'suspended') {
    try {
      await c.resume()
    } catch {
      /**
       * Swallowed on purpose, now that a clap can start the assistant.
       *
       * resume() rejects when there has been no user gesture, and a clap is not
       * one — the browser has no idea a microphone heard anything. Letting that
       * reject would abort the whole power-up over a sound that may well play
       * fine anyway (any earlier interaction with the page unlocks it). Boot
       * either way: the worst case is a silent start, not a dead one.
       */
    }
  }
  void loadOverrides()
}

/** Pick up any real audio files the user has dropped into public/audio/. */
async function loadOverrides() {
  const cues: Cue[] = ['boot', 'wake', 'listen', 'tool', 'done', 'error']
  await Promise.all(
    cues.map(async (cue) => {
      if (samples.has(cue)) return
      try {
        const res = await fetch(`/audio/${cue}.mp3`)
        if (!res.ok) return
        const buf = await audio().decodeAudioData(await res.arrayBuffer())
        samples.set(cue, buf)
      } catch {
        /* no override — the synthesised cue is used */
      }
    }),
  )
}

export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v))
  if (master) rampTo(master.gain, ducked ? volume * DUCK : volume, 0.05)
}

// ---------------------------------------------------------------------------
// Synthesis helpers
// ---------------------------------------------------------------------------

/** A pitched blip with an exponential decay — the basic HUD tick. */
function blip(
  freq: number,
  {
    at = 0,
    dur = 0.12,
    type = 'sine' as OscillatorType,
    gain = 0.25,
    sweepTo = 0,
  } = {},
) {
  const c = audio()
  const t = c.currentTime + at
  const osc = c.createOscillator()
  const env = c.createGain()

  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t + dur)

  // Fast attack, exponential tail — reads as electronic rather than musical.
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(gain, t + 0.008)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)

  osc.connect(env).connect(master!)
  osc.start(t)
  osc.stop(t + dur + 0.02)
}

/** Filtered noise burst — air, whooshes, transients. */
function noise({ at = 0, dur = 0.4, gain = 0.12, from = 400, to = 6000 } = {}) {
  const c = audio()
  const t = c.currentTime + at
  const frames = Math.floor(c.sampleRate * dur)
  const buf = c.createBuffer(1, frames, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1

  const src = c.createBufferSource()
  src.buffer = buf

  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 1.2
  filter.frequency.setValueAtTime(from, t)
  filter.frequency.exponentialRampToValueAtTime(to, t + dur)

  const env = c.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(gain, t + dur * 0.25)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)

  src.connect(filter).connect(env).connect(master!)
  src.start(t)
}

// ---------------------------------------------------------------------------

const synth: Record<Cue, () => void> = {
  /** Reactor spin-up: a rising sweep under stacked fifths. */
  boot: () => {
    noise({ dur: 2.2, gain: 0.1, from: 120, to: 5200 })
    blip(110, { dur: 2.4, type: 'sawtooth', gain: 0.1, sweepTo: 880 })
    blip(220, { at: 0.1, dur: 2.2, type: 'sine', gain: 0.09, sweepTo: 1320 })
    // The "online" confirmation — a clean rising third.
    blip(880, { at: 1.9, dur: 0.3, gain: 0.18 })
    blip(1320, { at: 2.05, dur: 0.45, gain: 0.2 })
  },

  /** Wake: two quick ascending pips. Deliberately short. */
  wake: () => {
    blip(1046, { dur: 0.09, gain: 0.22 })
    blip(1568, { at: 0.07, dur: 0.14, gain: 0.2 })
  },

  /** Listening: a single soft low pip so it doesn't fight the user's voice. */
  listen: () => blip(660, { dur: 0.1, gain: 0.14 }),

  /** A tool fired — a tiny mechanical tick. */
  tool: () => {
    blip(2200, { dur: 0.05, type: 'square', gain: 0.07 })
    noise({ dur: 0.1, gain: 0.05, from: 3000, to: 900 })
  },

  /** Turn complete: a descending pair, the inverse of wake. */
  done: () => {
    blip(1320, { dur: 0.1, gain: 0.14 })
    blip(880, { at: 0.08, dur: 0.2, gain: 0.13 })
  },

  /** Something failed — flat, slightly dissonant, not alarming. */
  error: () => {
    blip(320, { dur: 0.18, type: 'square', gain: 0.14 })
    blip(226, { at: 0.13, dur: 0.3, type: 'square', gain: 0.12 })
  },
}

export function play(cue: Cue) {
  if (!ctx || ctx.state !== 'running') return

  const sample = samples.get(cue)
  if (sample) {
    const src = ctx.createBufferSource()
    src.buffer = sample
    src.connect(master!)
    src.start()
    return
  }
  synth[cue]()
}

// ---------------------------------------------------------------------------
// Showtime score

/** A short original synth score for the demo sequence. It is generated on the
 * device, so the installer stays self-contained and does not borrow film music
 * or need a streaming connection. */
let showtime: { sources: AudioScheduledSourceNode[]; gain: GainNode; timer: number } | null = null

export function stopShowtimeScore() {
  if (!showtime || !ctx) return
  const active = showtime
  showtime = null
  window.clearTimeout(active.timer)
  rampTo(active.gain.gain, 0.0001, 0.28)
  window.setTimeout(() => {
    active.sources.forEach((source) => {
      try { source.stop() } catch { /* source already ended */ }
      source.disconnect()
    })
    active.gain.disconnect()
  }, 340)
}

export function startShowtimeScore(durationMs = 11_800) {
  if (!ctx || ctx.state !== 'running' || !master) return
  stopShowtimeScore()
  const c = audio()
  const gain = c.createGain()
  gain.gain.value = 0.0001
  gain.connect(master)
  const sources: AudioScheduledSourceNode[] = []
  const start = c.currentTime + 0.035

  const tone = (frequency: number, at: number, seconds: number, level: number, type: OscillatorType = 'sine') => {
    const osc = c.createOscillator()
    const env = c.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(frequency, start + at)
    env.gain.setValueAtTime(0.0001, start + at)
    env.gain.exponentialRampToValueAtTime(level, start + at + 0.018)
    env.gain.exponentialRampToValueAtTime(0.0001, start + at + seconds)
    osc.connect(env).connect(gain)
    osc.start(start + at)
    osc.stop(start + at + seconds + 0.04)
    sources.push(osc)
  }

  // Slow fifths establish the reactor, then an ascending arpeggio carries the
  // reveal. These are an original score, not a facsimile of a film cue.
  const roots = [73.42, 82.41, 98, 110, 98, 82.41]
  roots.forEach((root, index) => {
    const at = index * 1.8
    tone(root, at, 1.65, 0.075, 'sawtooth')
    tone(root * 1.5, at + 0.03, 1.5, 0.045, 'sine')
  })
  const notes = [220, 293.66, 329.63, 440, 493.88, 659.25, 880, 659.25]
  for (let step = 0; step < 32; step++) {
    const at = 1.05 + step * 0.28
    const note = notes[step % notes.length]
    tone(note, at, 0.24, step < 8 ? 0.035 : 0.07, step % 4 === 0 ? 'triangle' : 'sine')
  }
  // The final high triad is the “arc online” moment.
  ;[659.25, 830.61, 987.77].forEach((note, index) => tone(note, 9.3 + index * 0.06, 1.7, 0.095, 'sine'))

  rampTo(gain.gain, 0.75, 0.32)
  const timer = window.setTimeout(stopShowtimeScore, durationMs + 250)
  showtime = { sources, gain, timer }
}

/** Winter Arc is a colder, slower companion score: glassy intervals over a
 * sub-bass heartbeat. Entirely synthesised locally, so it remains usable
 * offline and deliberately avoids any borrowed soundtrack. */
export function startWinterArcScore(durationMs = 15_500) {
  if (!ctx || ctx.state !== 'running' || !master) return
  stopShowtimeScore()
  const c = audio()
  const gain = c.createGain()
  gain.gain.value = 0.0001
  gain.connect(master)
  const sources: AudioScheduledSourceNode[] = []
  const start = c.currentTime + 0.035
  const tone = (frequency: number, at: number, seconds: number, level: number, type: OscillatorType = 'sine') => {
    const osc = c.createOscillator()
    const env = c.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(frequency, start + at)
    env.gain.setValueAtTime(0.0001, start + at)
    env.gain.exponentialRampToValueAtTime(level, start + at + 0.025)
    env.gain.exponentialRampToValueAtTime(0.0001, start + at + seconds)
    osc.connect(env).connect(gain)
    osc.start(start + at)
    osc.stop(start + at + seconds + 0.04)
    sources.push(osc)
  }
  // D minor-derived tones keep it calm rather than triumphant.
  ;[55, 61.74, 73.42, 82.41, 73.42, 61.74].forEach((root, index) => {
    const at = index * 2.35
    tone(root, at, 2.2, 0.085, 'triangle')
    tone(root * 2.002, at + 0.02, 2.05, 0.035, 'sine')
  })
  const crystal = [293.66, 349.23, 440, 587.33, 698.46, 880]
  for (let step = 0; step < 25; step++) {
    const at = 1.2 + step * 0.47
    tone(crystal[(step * 3) % crystal.length], at, 0.6, 0.052, 'sine')
  }
  ;[440, 523.25, 659.25].forEach((note, index) => tone(note, 12.8 + index * 0.08, 2.2, 0.1, 'sine'))
  rampTo(gain.gain, 0.7, 0.45)
  const timer = window.setTimeout(stopShowtimeScore, durationMs + 250)
  showtime = { sources, gain, timer }
}

// ---------------------------------------------------------------------------
// Ambient bed
// ---------------------------------------------------------------------------

/** Resting level of the synthesised bed. */
const BED = 0.05

/**
 * A quiet room tone under everything. Two detuned low oscillators through a
 * lowpass — barely audible on its own, but its absence is obvious. Keeps the
 * interface feeling powered rather than paused.
 *
 * Only a fallback: when public/audio/ambient.mp3 is present music.ts owns this
 * layer, which is why nothing calls this today.
 */
export function startAmbient() {
  if (ambient || !ctx || ctx.state !== 'running') return
  const c = ctx

  const gain = c.createGain()
  gain.gain.value = 0
  gain.connect(master!)

  const frames = c.sampleRate * 4
  const buf = c.createBuffer(1, frames, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < frames; i++) {
    const t = i / c.sampleRate
    data[i] =
      (Math.sin(2 * Math.PI * 55 * t) * 0.5 +
        Math.sin(2 * Math.PI * 55.6 * t) * 0.5 + // slight detune = slow beating
        (Math.random() * 2 - 1) * 0.06) *
      0.5
  }

  const source = c.createBufferSource()
  source.buffer = buf
  source.loop = true

  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 260

  source.connect(lp).connect(gain)
  source.start()
  ambient = { source, gain }
  rampTo(gain.gain, BED, 3)
}

export function stopAmbient() {
  if (!ambient || !ctx) return
  const { source, gain } = ambient
  ambient = null
  rampTo(gain.gain, 0, 0.6)
  // Stop the node itself once it's inaudible, or it keeps a buffer looping in
  // the graph for as long as the page is open.
  setTimeout(() => {
    source.stop()
    source.disconnect()
    gain.disconnect()
  }, 800)
}

/**
 * Duck everything this module makes while JARVIS speaks.
 *
 * This used to touch only the synthesised bed, and return early when there
 * wasn't one — which there never is, because the ambient layer in the shipped
 * configuration comes from music.ts and startAmbient() below is a fallback
 * nothing currently calls. So it was a permanent no-op. The interface cues and
 * the bed both hang off the master, so ducking there is honest either way: with
 * the bed running it ducks the bed, and without it it still keeps a tool tick
 * or a completion chime from landing on top of a word.
 */
export function duck(on: boolean) {
  if (ducked === on || !master) return
  ducked = on
  // Out of the way quickly, back slowly — a fast recovery is audible as a
  // swell, and there is usually another sentence right behind the first.
  rampTo(master.gain, on ? volume * DUCK : volume, on ? 0.12 : 0.5)
}
