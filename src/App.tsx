import { useEffect, useRef, useState } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { Arrival, type ArrivalStage } from './ui/Arrival'
import { useStore } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  toggleModel,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** A deliberate breath between the boot film resolving and the reactor taking
 * centre stage. It lets the first score finish instead of stepping on it. */
const WELCOME_HANDOFF_MS = 4000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

const ARC_COLOURS: Record<string, string> = {
  cyan: '#57e9ff',
  blue: '#529bff',
  violet: '#b588ff',
  purple: '#b588ff',
  red: '#ff5d52',
  orange: '#ff8d4d',
  gold: '#ffc76d',
  green: '#63f6bd',
  white: '#dffcff',
}

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const [arrivalStage, setArrivalStage] = useState<ArrivalStage>('idle')
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)
  const arcControl = useRef(false)
  const arcBaseline = useRef<{ span: number; angle: number; y: number } | null>(null)
  const arcPulseReady = useRef(true)
  const arcResetSince = useRef<number | null>(null)
  const arcControlAppearance = useRef<ReturnType<typeof snapshotArcAppearance> | null>(null)
  const preferredArcColour = useRef<string | null>(null)
  const introLocked = useRef(false)
  const welcomeTimers = useRef<number[]>([])
  const lightingTimer = useRef<number | null>(null)
  const lightingMode = useRef(-1)
  // Explicitly a browser timer: WebKit returns a number while the Node types
  // used by the build describe a Timeout object.
  const arcPoll = useRef<number | null>(null)
  const showtime = useRef(false)
  const showtimeTimers = useRef<number[]>([])

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  function snapshotArcAppearance() {
    const ui = store.getState().ui
    return { accent: ui.accent, background: ui.background, reactor: { ...ui.reactor } }
  }

  const clearLightingMode = () => {
    if (lightingTimer.current !== null) clearInterval(lightingTimer.current)
    lightingTimer.current = null
  }

  const restorePreferredArcColour = () => {
    const colour = preferredArcColour.current
    store.getState().applyUi({ accent: colour, reactor: { color: colour } })
  }

  const setArcColour = (name: string) => {
    const colour = ARC_COLOURS[name]
    if (!colour) return false
    clearLightingMode()
    preferredArcColour.current = colour
    const s = store.getState()
    s.applyUi({ accent: colour, reactor: { color: colour, intensity: 1.35, spin: 1.25 } })
    s.fireEffect('pulse')
    s.setCaption(`ARC CORE // ${name.toUpperCase()} SPECTRUM LOCKED`)
    sfx.play('done')
    return true
  }

  /** Mechanical-keyboard-style reactor profiles. I moves through the whole
   * rack; the RGB wave is deliberately live rather than a single colour. */
  const cycleArcLighting = () => {
    clearLightingMode()
    lightingMode.current = (lightingMode.current + 1) % 5
    const s = store.getState()
    const fixed = (label: string, colour: string, background: string) => {
      preferredArcColour.current = colour
      s.applyUi({
        accent: colour,
        background,
        reactor: { color: colour, style: 'ring', scale: 1, intensity: 1.45, spin: 1.45 },
      })
      s.setCaption(`ARC LIGHTING // ${label}`)
    }

    if (lightingMode.current === 0) fixed('AURORA', '#52ffe1', '#03130f')
    else if (lightingMode.current === 1) fixed('MAGMA', '#ff714d', '#190806')
    else if (lightingMode.current === 2) fixed('ULTRAVIOLET', '#b588ff', '#0d061a')
    else if (lightingMode.current === 3) {
      const wave = ['#52ffe1', '#6ca8ff', '#b588ff', '#ff5f9a', '#ffb45c', '#63f6bd']
      let step = 0
      const paint = () => {
        const colour = wave[step++ % wave.length]
        preferredArcColour.current = colour
        const live = store.getState()
        live.applyUi({ accent: colour, background: '#070614', reactor: { color: colour, style: 'ring', intensity: 1.65, spin: 2.1 } })
      }
      paint()
      lightingTimer.current = window.setInterval(paint, 440)
      s.setCaption('ARC LIGHTING // RGB WAVE')
    } else {
      preferredArcColour.current = null
      s.applyUi({
        accent: null,
        background: null,
        reactor: { color: null, style: 'ring', scale: 1, intensity: 1, spin: 1 },
      })
      s.setCaption('ARC LIGHTING // STOCK CYAN')
    }
    s.fireEffect('pulse')
    sfx.play('done')
  }

  /** The supplied welcome line is 17.66 seconds. This sequence owns the
   * interface until it ends, so a stray key cannot turn the arrival into a
   * half-finished effect or start listening through the audio. */
  const runWelcomeArrival = async () => {
    introLocked.current = true
    setArrivalStage('arrival')
    const cue = (delay: number, work: () => void) => {
      welcomeTimers.current.push(window.setTimeout(work, delay))
    }
    const s = store.getState()
    // The boot-film score belongs to the first sequence only. Cut it before
    // the owner-arrival voice takes the stage.
    music.stopAll()
    // One restrained, physical vocabulary: cold cyan, white-hot core, rings
    // assembling out of darkness. This feels like an arc reactor being built,
    // rather than a colour-preset slideshow.
    s.setCaption('HOUSE PROTOCOL // REACTOR BAY OPEN')
    s.applyUi({ accent: '#1a3640', background: '#010509', reactor: { color: '#57e9ff', style: 'wire', visible: false, scale: 0.16, intensity: 0, spin: 0.04 } })
    s.fireEffect('glitch')
    cue(650, () => {
      s.setCaption('FIELD COILS // ALIGNING')
      s.applyUi({ accent: '#57e9ff', reactor: { visible: true, style: 'wire', scale: 0.34, intensity: 0.22, spin: 0.55 } })
      s.fireEffect('scan')
      sfx.play('tool')
    })
    cue(2200, () => {
      s.setCaption('CONTAINMENT RINGS // SEQUENCING')
      s.applyUi({ reactor: { scale: 0.56, intensity: 0.56, spin: 2.4 } })
      s.fireEffect('shake')
      sfx.play('tool')
    })
    cue(4550, () => {
      s.setCaption('PALLADIUM CORE // CHARGING')
      s.applyUi({ accent: '#a9f7ff', reactor: { color: '#a9f7ff', style: 'sphere', scale: 0.72, intensity: 1.15, spin: 3.35 } })
      s.fireEffect('pulse')
      sfx.play('wake')
    })
    cue(7200, () => {
      s.setCaption('MAGNETIC FIELD // HOLDING')
      s.applyUi({ accent: '#57e9ff', reactor: { color: '#57e9ff', style: 'wire', scale: 0.92, intensity: 1.45, spin: 4.35 } })
      s.fireEffect('scan')
    })
    cue(10_150, () => {
      s.setCaption('ARC CORE // CRITICAL MASS')
      s.applyUi({ accent: '#e3fdff', reactor: { color: '#e3fdff', style: 'sphere', scale: 1.08, intensity: 2.5, spin: 4.8 } })
      s.fireEffect('pulse')
      sfx.play('wake')
    })
    cue(13_250, () => {
      s.setCaption('PRIMARY REACTOR // STABILISING')
      s.applyUi({ accent: '#7cefff', reactor: { color: '#7cefff', style: 'ring', scale: 1.22, intensity: 2.05, spin: 3.2 } })
      s.fireEffect('shake')
      sfx.play('tool')
    })
    cue(16_000, () => {
      s.setCaption('ARC REACTOR // ONLINE')
      s.applyUi({ accent: '#57e9ff', reactor: { color: '#57e9ff', style: 'ring', scale: 1.04, intensity: 1.55, spin: 1.45 } })
      s.fireEffect('flash')
      sfx.play('done')
    })

    // The actual media is the authority; the floor protects the locked state
    // if a WebView fails to report an `ended` event for a local asset.
    await Promise.all([
      music.playWelcome(),
      new Promise<void>((resolve) => window.setTimeout(resolve, 17_660)),
    ])
    welcomeTimers.current.forEach((timer) => clearTimeout(timer))
    welcomeTimers.current = []
    restorePreferredArcColour()
    s.setCaption('')
    setArrivalStage('idle')
    introLocked.current = false
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    restorePreferredArcColour()
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /**
   * A repeatable demo cue, not a permanently noisy theme. It uses the real
   * reactor controls and restores the owner’s current visual choices when it
   * ends, so it is safe to use in the middle of a conversation or a demo.
   */
  const runShowtime = async () => {
    if (showtime.current) return
    // L is a user gesture. Unlock exactly like the ignition/clap path before
    // scheduling any score, so the first Showtime after launch is never mute.
    await sfx.unlockAudio()
    showtime.current = true
    const before = store.getState().ui
    const restore = () => {
      const s = store.getState()
      s.applyUi({
        accent: before.accent,
        background: before.background,
        palette: before.palette,
        reactor: before.reactor,
        chrome: before.chrome,
      })
      s.setCaption('')
      sfx.stopShowtimeScore()
      showtime.current = false
      showtimeTimers.current = []
    }
    const cue = (delay: number, work: () => void) => {
      showtimeTimers.current.push(window.setTimeout(work, delay))
    }

    const s = store.getState()
    s.setCaption('SHOWTIME — ARC REACTOR SEQUENCE // INITIALISING SCORE')
    sfx.startShowtimeScore(11_800)
    sfx.play('boot')
    const announcer = createSpeaker()
    speaker.current = announcer
    announcer.say('Showtime sequence initialised. Arc reactor coming online.')
    void announcer.end()
    s.applyUi({
      accent: '#6feaff',
      reactor: { color: '#6feaff', style: 'wire', scale: 0.46, intensity: 0.28, spin: 0.12 },
    })
    s.fireEffect('scan')
    cue(900, () => {
      store.getState().setCaption('ARC CORE // FIELD COHERENCE 24%')
      store.getState().applyUi({ reactor: { scale: 0.72, intensity: 0.62, spin: 0.72 } })
      sfx.play('tool')
    })
    cue(2100, () => {
      store.getState().setCaption('ARC CORE // MAGNETIC CONTAINMENT')
      store.getState().applyUi({ reactor: { scale: 1.08, intensity: 1.25, spin: 1.7 } })
      sfx.play('tool')
    })
    cue(3450, () => {
      store.getState().setCaption('ARC CORE // ENERGY TRANSFER')
      store.getState().applyUi({ reactor: { scale: 1.44, intensity: 2.45, spin: 3.4 } })
      store.getState().fireEffect('pulse')
      sfx.play('wake')
    })
    cue(5200, () => {
      store.getState().setCaption('ARC CORE // THERMAL SHIELDING')
      store.getState().applyUi({ accent: '#ffb347', reactor: { color: '#ffb347', style: 'sphere', scale: 1.2, intensity: 1.8, spin: 2.1 } })
      store.getState().fireEffect('flash')
      sfx.play('tool')
    })
    cue(7200, () => {
      store.getState().setCaption('ARC CORE // OUTPUT LIMITER RELEASED')
      store.getState().applyUi({ accent: '#69f8d4', reactor: { color: '#69f8d4', style: 'ring', scale: 1.36, intensity: 2.6, spin: 4.2 } })
      store.getState().fireEffect('pulse')
      sfx.play('wake')
    })
    cue(9600, () => {
      store.getState().setCaption('ARC REACTOR // ONLINE')
      store.getState().fireEffect('flash')
      sfx.play('done')
    })
    cue(12_100, restore)
  }

  /** A distinct cold-performance protocol — not a theme toggle. It restores
   * the existing scene at the end so the everyday assistant stays calm. */
  const runWinterArc = async () => {
    if (showtime.current) return
    // Same audio unlocking contract as the app's first click/clap.
    await sfx.unlockAudio()
    showtime.current = true
    const before = store.getState().ui
    const restore = () => {
      const s = store.getState()
      s.applyUi({
        accent: before.accent,
        background: before.background,
        palette: before.palette,
        reactor: before.reactor,
        chrome: before.chrome,
      })
      s.setCaption('')
      sfx.stopShowtimeScore()
      showtime.current = false
      showtimeTimers.current = []
    }
    const cue = (delay: number, work: () => void) => showtimeTimers.current.push(window.setTimeout(work, delay))
    const s = store.getState()
    s.setCaption('WINTER ARC // COLD START PROTOCOL')
    sfx.startWinterArcScore(15_500)
    sfx.play('boot')
    const announcer = createSpeaker()
    speaker.current = announcer
    announcer.say('Winter Arc protocol engaged. Cold start commencing.')
    void announcer.end()
    s.applyUi({
      accent: '#b9f4ff',
      background: '#020914',
      reactor: { color: '#b9f4ff', style: 'wire', scale: 0.36, intensity: 0.18, spin: 0.08 },
    })
    s.fireEffect('winter')
    cue(1200, () => {
      store.getState().setCaption('WINTER ARC // TEMPERATURE STABLE')
      store.getState().applyUi({ reactor: { scale: 0.58, intensity: 0.5, spin: 0.42 } })
      store.getState().fireEffect('scan')
      sfx.play('tool')
    })
    cue(3100, () => {
      store.getState().setCaption('WINTER ARC // DISCIPLINE MODE ENGAGED')
      store.getState().applyUi({ reactor: { scale: 0.86, intensity: 0.95, spin: 1.05 } })
      store.getState().fireEffect('winter')
      sfx.play('listen')
    })
    cue(5600, () => {
      store.getState().setCaption('WINTER ARC // RESILIENCE FIELD FORMING')
      store.getState().applyUi({ reactor: { style: 'sphere', scale: 1.12, intensity: 1.55, spin: 1.7 } })
      store.getState().fireEffect('pulse')
      sfx.play('wake')
    })
    cue(8500, () => {
      store.getState().setCaption('WINTER ARC // NO EXCUSES. EXECUTE.')
      store.getState().applyUi({ accent: '#76d9ff', reactor: { color: '#76d9ff', style: 'ring', scale: 1.32, intensity: 2.28, spin: 3.3 } })
      store.getState().fireEffect('winter')
      sfx.play('tool')
    })
    cue(12_400, () => {
      store.getState().setCaption('WINTER ARC // LOCKED IN')
      store.getState().fireEffect('flash')
      sfx.play('done')
    })
    cue(15_900, restore)
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  /** One Arc Control switch shared by the keyboard and voice commands. */
  const toggleArcControl = () => {
    if (arcControl.current) {
      arcControl.current = false
      arcBaseline.current = null
      if (arcPoll.current) clearInterval(arcPoll.current)
      arcPoll.current = null
      arcResetSince.current = null
      arcPulseReady.current = true
      hands.disableHands()
      hands.setPointerInteractionEnabled(true)
      const s = store.getState()
      s.setGestures(false)
      s.setArcControl(false)
      const appearance = arcControlAppearance.current
      arcControlAppearance.current = null
      if (appearance) s.applyUi(appearance)
      else restorePreferredArcColour()
      s.setCaption('ARC CONTROL STANDING BY')
      s.setError(null)
      return
    }

    const before = snapshotArcAppearance()
    arcControlAppearance.current = before
    const s = store.getState()
    s.setError(null)
    s.applyUi({
      accent: '#ff764d',
      reactor: { color: '#ff764d', style: 'wire', scale: 0.92, intensity: 1.8, spin: 1.9 },
    })
    s.fireEffect('scan')
    hands.setPointerInteractionEnabled(false)
    void hands.enableHands().then(() => {
      arcControl.current = true
      arcBaseline.current = null
      arcResetSince.current = null
      arcPulseReady.current = true
      store.getState().setGestures(true)
      store.getState().setArcControl(true)
      store.getState().setCaption('ARC CONTROL ACTIVE — HOLD BOTH HANDS IN VIEW TO CALIBRATE.')
      arcPoll.current = window.setInterval(() => {
        const control = hands.twoPalmControl()
        const pinches = hands.pinchCount()
        if (pinches >= 2) {
          if (!arcResetSince.current) arcResetSince.current = Date.now()
          if (Date.now() - arcResetSince.current > 500) {
            arcBaseline.current = null
            arcResetSince.current = null
            store.getState().setCaption('ARC CONTROL RESET — HOLD BOTH HANDS STILL.')
            sfx.play('listen')
          }
          return
        }
        arcResetSince.current = null
        if (pinches === 1 && arcPulseReady.current) {
          arcPulseReady.current = false
          store.getState().fireEffect('pulse')
          store.getState().applyUi({ reactor: { intensity: 2.9, spin: 4.5 } })
          store.getState().setCaption('ARC PULSE DISCHARGED')
          sfx.play('done')
          window.setTimeout(() => { arcPulseReady.current = true }, 850)
        }
        if (!control) return
        if (!arcBaseline.current) {
          arcBaseline.current = control
          store.getState().setCaption('ARC CONTROL CALIBRATED — SPREAD, LIFT, OR TILT BOTH HANDS.')
          sfx.play('listen')
          return
        }
        const baseline = arcBaseline.current
        const scale = Math.max(0.55, Math.min(2.35, control.span / baseline.span))
        const turn = Math.abs(control.angle - baseline.angle)
        const wrappedTurn = Math.min(turn, Math.PI * 2 - turn)
        const energy = Math.max(0.45, Math.min(2.75, 1.1 + (baseline.y - control.y) / 220))
        store.getState().applyUi({ reactor: { scale, intensity: energy, spin: Math.max(0.7, Math.min(4.5, 1 + wrappedTurn * 1.4)) } })
      }, 90)
    }).catch((err: Error) => {
      arcControl.current = false
      arcResetSince.current = null
      hands.setPointerInteractionEnabled(true)
      const s = store.getState()
      s.setGestures(false)
      s.setArcControl(false)
      const appearance = arcControlAppearance.current
      arcControlAppearance.current = null
      if (appearance) s.applyUi(appearance)
      s.setError(
        err?.name === 'NotAllowedError'
          ? 'Camera permission is required for Arc Control. Enable JARVIS in System Settings, then try again.'
          : `Arc Control could not start: ${err?.message ?? err}`,
      )
    })
  }

  /** Fast scene commands never wait for the language model. */
  const runSpokenMode = (said: string) => {
    const command = said.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
    const colour = /\b(?:arc|reactor|core)(?:\s+colour|\s+color)?\s+(?:to\s+)?(cyan|blue|violet|purple|red|orange|gold|green|white)\b/.exec(command)
      ?? /\b(?:make|set|change|turn)\s+(?:the\s+)?(?:arc|reactor|core)(?:\s+(?:colour|color))?\s+(?:to\s+)?(cyan|blue|violet|purple|red|orange|gold|green|white)\b/.exec(command)
    if (colour && setArcColour(colour[1])) return true
    if (/\b(?:winter arc|winter mode)\b/.test(command)) { void runWinterArc(); return true }
    if (/\b(?:showtime|show time)\b/.test(command)) { void runShowtime(); return true }
    if (/\b(?:arc control|arc mode)\b/.test(command)) { toggleArcControl(); return true }
    return false
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    if (introLocked.current) return
    if (runSpokenMode(said)) {
      store.getState().pushTurn({ id: newId(), role: 'user', text: said })
      store.getState().pushTurn({ id: newId(), role: 'jarvis', text: 'Mode command accepted.' })
      return
    }
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')
    // Thinking is deliberately visible: a violet, wire-framed core suggests
    // computation without needing another line of UI text. It is restored to
    // the owner's chosen spectrum as soon as the answer begins speaking.
    s.applyUi({ accent: '#b588ff', reactor: { color: '#b588ff', style: 'wire', intensity: 1.45, spin: 2.8 } })

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const { text } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            restorePreferredArcColour()
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) {
            store.getState().setPhase('tooling')
            store.getState().applyUi({ accent: '#ffab5b', reactor: { color: '#ffab5b', intensity: 1.7, spin: 3.3 } })
          }
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      })

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        restorePreferredArcColour()
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    if (introLocked.current) return
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    if (introLocked.current) return
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    if (introLocked.current) return
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // Preload the owner's arrival line while this user gesture has audio
    // permission. It starts only after the boot film has fully resolved.
    music.enable()
    music.primeWelcome()
    // The video transition keeps its own score; it fades out before the
    // welcome clip begins on the live arc.
    music.playBoot()
    music.startAmbient()

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // The boot film is a complete sequence, not background decoration. The
    // live arc appears only after its final reactor beat has resolved.
    await new Promise((r) => setTimeout(r, 8800))
    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // Scene mounts only after the boot film; now it gets the entire welcome
    // clip and no competing keyboard, command dock, voice loop, or animation.
    store.getState().setPhase('dormant')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    // The silent handoff is itself a scene: 1.5 seconds of calm establishes
    // scale, then the bay goes dark for another 1.5 before the arrival line
    // lands. It reads as an intentional cut, not as the app waiting.
    introLocked.current = true
    setArrivalStage('handoff')
    store.getState().setCaption('SYSTEM ONLINE // REACTOR BAY STANDBY')
    await new Promise<void>((resolve) => window.setTimeout(resolve, WELCOME_HANDOFF_MS / 2))
    store.getState().applyUi({
      accent: '#173841',
      background: '#010509',
      reactor: { color: '#57e9ff', style: 'wire', visible: false, scale: 0.12, intensity: 0, spin: 0.04 },
    })
    store.getState().setCaption('REACTOR BAY // SEALING')
    store.getState().fireEffect('scan')
    sfx.play('tool')
    await new Promise<void>((resolve) => window.setTimeout(resolve, WELCOME_HANDOFF_MS / 2))
    await runWelcomeArrival()

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })

    store.getState().setPhase('dormant')
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      if (introLocked.current) {
        e.preventDefault()
        return
      }
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // Shift+M is the deliberate two-gear control: Bolt for instant voice
      // replies, Lightning when the next task needs more agentic horsepower.
      // The bridge holds both the API key and the selected model, so no secret
      // ever reaches this event handler or the browser bundle.
      if (
        e.code === 'KeyM' &&
        e.shiftKey &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        silence()
        interrupt()
        if (toggleModel()) {
          store.getState().setCaption('MODEL SWITCHED — NVIDIA PROFILE UPDATED.')
          store.getState().setError(null)
          sfx.play('done')
        } else {
          store.getState().setError('Model switching needs the NVIDIA bridge online.')
        }
        return
      }

      if (e.key === 'i' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        cycleArcLighting()
        return
      }

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // A staged reveal for a real audience. It is intentionally separate
      // from Arc Control: L performs; K gives the owner live control.
      if (e.key === 'l' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        void runShowtime()
        return
      }

      if (e.key === 'w' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        void runWinterArc()
        return
      }

      // G used the experimental GPU hand path, which could close the native
      // shell on this Mac. It is deliberately disabled; K is the safe and
      // explicit two-palm Arc Control activation.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        store.getState().setError('Hand control moved to K. G is disabled for stability.')
        return
      }

      if (e.key === 'k' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        toggleArcControl()
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      if (arcPoll.current) clearInterval(arcPoll.current)
      clearLightingMode()
      welcomeTimers.current.forEach((timer) => clearTimeout(timer))
      showtimeTimers.current.forEach((timer) => clearTimeout(timer))
      store.getState().setArcControl(false)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      {phase !== 'offline' && phase !== 'boot' && <Scene />}
      <Arrival stage={arrivalStage} />
      <Hud onCommand={(command) => void respond(command)} />
      <Boot />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
