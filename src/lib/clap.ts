import { getMic } from './audio'

/**
 * Clap to wake him up.
 *
 * The ignition button exists because browsers will not let a page make a sound
 * until someone has interacted with it. That is still true, so the button is
 * not going anywhere — but there is no reason it should be the only way in, and
 * clapping at a dark room to bring it up is a better opening than clicking a
 * button.
 *
 * A clap is not loud, it is SHARP. Distinguishing it from a door, a cough or a
 * dropped mug is entirely a question of shape: a clap goes from silence to peak
 * in a couple of milliseconds and is gone again inside a tenth of a second.
 * Almost nothing else in a room does both. So this looks for three things in
 * order — quiet before, a near-instant rise, and a fast collapse — and refuses
 * anything that fails one of them. Loudness alone is not evidence.
 */

/** How far above the running floor counts as a candidate transient. */
const PEAK_OVER_FLOOR = 7
/** ...and an absolute floor, so a silent room cannot make a whisper a clap. */
const MIN_PEAK = 0.055

/** The room has to have been this quiet just before the strike. */
const QUIET_BEFORE = 0.16
/** Frames of history kept — about a third of a second at 60fps. */
const HISTORY = 20
/** How many frames back "just before" means. */
const LOOKBACK = 5

/** Confirmed once the level has fallen this far below the peak... */
const DECAY_TO = 0.35
/** ...within this long. Speech and music simply do not collapse this fast. */
const DECAY_MS = 130
/** A candidate that has not decayed by now was something sustained. */
const GIVE_UP_MS = 260

/** Nothing counts for this long after a clap, so one strike is one event. */
const COOLDOWN_MS = 1200

export type ClapListener = { stop: () => void }

export const diag = {
  listening: false,
  claps: 0,
  lastPeak: 0,
  rejected: '',
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__clap = diag
}

/**
 * Listen until told to stop. Resolves once the microphone is actually open, so
 * a caller can tell "not listening" from "listening and hearing nothing".
 *
 * Never throws for a refused microphone — clapping is an alternative to the
 * button, not a requirement, and an interface that reports an error about a
 * feature the user never asked for is worse than one that quietly does without.
 */
export async function listenForClap(onClap: () => void): Promise<ClapListener> {
  let stream: MediaStream
  try {
    stream = await getMic()
  } catch {
    diag.rejected = 'microphone unavailable'
    return { stop: () => {} }
  }

  const ctx = new AudioContext()
  void ctx.resume()
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  // Small window: we are looking for an attack, and a long FFT smears exactly
  // the sharpness that identifies one.
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0
  source.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)

  const history: number[] = []
  let floor = 0.01
  let stopped = false
  let raf = 0
  let lastClap = 0

  /** A transient under examination, waiting to prove it decays. */
  let candidate: { at: number; peak: number } | null = null

  const rms = () => {
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    return Math.sqrt(sum / buf.length)
  }

  const tick = () => {
    if (stopped) return
    raf = requestAnimationFrame(tick)

    const now = performance.now()
    const level = rms()
    history.push(level)
    if (history.length > HISTORY) history.shift()

    // The floor tracks the room, and never while a candidate is in flight —
    // otherwise the clap itself raises the bar it is being measured against.
    if (!candidate && level < floor * 3) {
      floor += (level - floor) * 0.05
      floor = Math.max(floor, 0.002)
    }

    if (candidate) {
      if (level < candidate.peak * DECAY_TO && now - candidate.at < DECAY_MS) {
        // Quiet before, instant rise, immediate collapse. That is a clap.
        candidate = null
        lastClap = now
        diag.claps++
        diag.rejected = ''
        onClap()
      } else if (now - candidate.at > GIVE_UP_MS) {
        // Still going. A voice, a chair, music — something with a body to it.
        diag.rejected = 'too sustained to be a clap'
        candidate = null
      } else {
        candidate.peak = Math.max(candidate.peak, level)
      }
      return
    }

    if (now - lastClap < COOLDOWN_MS) return
    if (level < MIN_PEAK || level < floor * PEAK_OVER_FLOOR) return

    // Was the room actually quiet a moment ago? A rise out of noise is a swell,
    // not a strike, and this is the test that rejects most of speech.
    const before = history[history.length - 1 - LOOKBACK]
    if (before === undefined || before > level * QUIET_BEFORE) {
      diag.rejected = 'no silence before it'
      return
    }

    diag.lastPeak = level
    candidate = { at: now, peak: level }
  }

  tick()
  diag.listening = true

  return {
    stop: () => {
      stopped = true
      diag.listening = false
      cancelAnimationFrame(raf)
      try {
        source.disconnect()
        // The shared microphone stream is NOT stopped here. It belongs to
        // audio.ts and the voice loop takes it over the moment JARVIS boots;
        // stopping it would take the assistant's hearing with it.
        void ctx.close()
      } catch {
        /* already gone */
      }
    },
  }
}
