import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { OneEuroPoint } from './oneEuro'
import { holdCamera, releaseCamera } from './camera'

/**
 * Hands.
 *
 * Your hand appears on screen as a skeleton — every joint, every finger — and
 * the tip of your index finger is the cursor. Pinch thumb to finger to press.
 *
 * Drawing the whole hand rather than a floating dot is not decoration. You
 * cannot see your own hand against the screen, so with only a dot you are
 * aiming something whose orientation and shape you have to infer. With the
 * skeleton you can see the pinch closing before it fires, see which finger the
 * cursor is riding on, and see immediately when tracking has lost you rather
 * than wondering why nothing responds.
 *
 * The architectural decision is that nothing here knows what a blade is. No
 * hit-testing of blades, no calls to close or move them, no knowledge of the
 * header you drag by. It turns a hand into a position and a press and
 * dispatches ordinary PointerEvents there — so every interaction the mouse
 * already has works with a hand for free, and anything added later works
 * without being taught that hands exist.
 *
 * The camera is off until you ask for it, says so on screen the whole time it
 * is on, and nothing leaves the machine: the model runs locally on the GPU and
 * frames are read and discarded.
 */

/**
 * Served from our own origin, copied out of node_modules by scripts/start.mjs.
 *
 * Not a CDN, for two reasons that both bite. The runtime arrives as a script
 * and the page's CSP names no CDN in `script-src` — so a CDN path is simply
 * blocked, and the symptom is gesture control that never starts with nothing
 * obviously wrong. And a CDN import is a live supply-chain dependency:
 * executable code, re-resolved every load, that we neither control nor can pin
 * against being changed underneath us.
 */
const WASM_BASE = '/mediapipe'

/**
 * This supplies fixed model weights. Frames never leave the Mac. We use its
 * CPU delegate below because WebKit's GPU delegate has proved unstable inside
 * this native shell on some Apple Silicon Macs.
 */
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

/* ------------------------------------------------------------------ anatomy */

export const WRIST = 0
const THUMB_MCP = 2
export const THUMB_TIP = 4
const INDEX_PIP = 6
export const INDEX_TIP = 8
const MIDDLE_MCP = 9
const MIDDLE_PIP = 10
const MIDDLE_TIP = 12
const RING_PIP = 14
const RING_TIP = 16
const PINKY_PIP = 18
const PINKY_TIP = 20

/**
 * The skeleton, as pairs of landmark indices.
 *
 * Written out rather than taken from HandLandmarker.HAND_CONNECTIONS so the
 * renderer does not depend on a static that the library is free to reshape, and
 * so the palm arch below reads as a deliberate choice.
 */
export const BONES: readonly [number, number][] = [
  // thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // middle
  [9, 10], [10, 11], [11, 12],
  // ring
  [13, 14], [14, 15], [15, 16],
  // pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // the arch across the knuckles, which is what makes it read as a hand
  // rather than as five separate sticks
  [5, 9], [9, 13], [13, 17],
]

export const TIPS = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP]

/* -------------------------------------------------------------------- tuning */

/**
 * 1€ filter constants, tuned by the published method: beta at zero, drop
 * minCutoff until a resting hand stops shivering, then raise beta until a fast
 * movement stops trailing.
 *
 * The cursor is filtered harder than the skeleton. Aiming is a precision task
 * and benefits from every bit of steadiness; the skeleton is a picture of your
 * hand and only has to look alive, so it is allowed to be looser and more
 * responsive. Filtering both identically made the drawing feel dead.
 */
const CURSOR_MIN_CUTOFF = 1.1
const CURSOR_BETA = 0.012
const SKELETON_MIN_CUTOFF = 2.4
const SKELETON_BETA = 0.02

/**
 * Pinch thresholds, as a fraction of hand span rather than an absolute.
 *
 * The raw gap between two fingertips is meaningless alone: it halves when you
 * lean back and doubles when you lean in, so a fixed threshold means the
 * interface only works at one distance from the camera. Dividing by the span
 * from wrist to middle knuckle — a length that shrinks with the same
 * perspective — makes it a property of the hand's shape rather than its
 * distance, which is what a pinch actually is.
 *
 * Two thresholds, not one: it takes a tighter pinch to start a press than to
 * keep one, so the press cannot flicker on the boundary.
 */
const PINCH_ON = 0.40
const PINCH_OFF = 0.60

/** A finger counts as extended when its tip is this much further from the
 *  wrist than its middle joint. Ratio rather than a y-comparison, so it still
 *  works with your hand rotated or upside down. */
const EXTEND_RATIO = 1.12

/**
 * A gesture must hold for this long before it counts.
 *
 * Fingers pass through other shapes on the way to the one you meant — a fist
 * becomes a point by way of several ambiguous frames — and acting on those
 * intermediate readings is what makes gesture interfaces feel possessed.
 */
const GESTURE_HOLD_MS = 140

/**
 * A pinch has to survive this long before it presses.
 *
 * Pinch used to be exempt from any hold at all, on the reasoning that a press
 * is the one gesture where latency is felt. True, but it made every transition
 * between poses a hazard: going from a framing L to a point, or from a fist to
 * an open hand, takes the fingers through arrangements that momentarily read as
 * a pinch. Each of those fired a press — grabbing a blade you were not touching
 * and dropping it somewhere you did not choose.
 *
 * Seventy milliseconds is four frames. It is comfortably below the threshold at
 * which a press feels delayed, and comfortably above the one or two frames a
 * hand spends passing through a shape on its way to another one.
 */
const PINCH_CONFIRM_MS = 70

/**
 * After the finger pose changes, presses are ignored for this long.
 *
 * The confirm window above catches a pinch that flickers. This catches the
 * other half of the problem: a pose that genuinely settles into something
 * pinch-shaped for a moment while the hand is still rearranging itself. Both
 * are needed, because they fail in opposite directions.
 */
const POSE_SETTLE_MS = 220

/** Below this many pixels of travel, a press was a click rather than a drag. */
const CLICK_SLOP = 20

/**
 * How far back a press aims.
 *
 * A pinch takes about this long from "hand open, pointing at the thing" to
 * "fingers touching", and the fingertip travels several centimetres over that
 * time — so the position at the instant the press fires is not the position you
 * aimed from. The trail below keeps a short history and the press hit-tests
 * where the cursor was this long ago.
 */
const AIM_LAG_MS = 190
/** Nothing older than this is kept; two frames' worth of slack over the lag. */
const TRAIL_MS = 500

export type Gesture = 'point' | 'pinch' | 'frame' | 'open' | 'fist' | 'peace' | 'none'
export type Side = 'left' | 'right'

/**
 * Whether MediaPipe's handedness label needs inverting.
 *
 * False, because that is what the screen actually showed. The older Hands docs
 * note that handedness assumes a mirrored selfie image and should be swapped if
 * your input is not mirrored — we feed the raw camera frame, so a swap looked
 * right on paper and named every hand backwards in practice. This build of the
 * Tasks API already reports the real hand.
 *
 * A constant rather than a hardcoded expression so that a different build, or a
 * genuinely pre-mirrored input, is a one-word change.
 */
const SWAP_HANDEDNESS = false

/**
 * Which tracked hand a detection belongs to.
 *
 * Handedness alone is not enough to key on, and using it that way caused the
 * worst bug in this file. The classifier is confident but not stable: it
 * mislabels a hand for a frame or two fairly often, especially while the hand
 * is rotating or half out of frame. Keyed purely on the label, that single
 * frame moves the hand into the other slot — which drops the old slot, fires
 * pointercancel, and silently ends whatever was being dragged. The symptom is
 * a drag that works once and then refuses to start again.
 *
 * So identity comes from continuity first: a detection belongs to whichever
 * tracked hand was nearest last frame. Your hand cannot teleport across the
 * screen between frames, but its label can flip, so position is the more
 * trustworthy signal by a wide margin. Handedness decides only where a hand
 * that is genuinely new goes.
 */
const MAX_JUMP_FRACTION = 0.28

function slotFor(
  side: Side,
  wrist: { x: number; y: number },
  taken: Set<number>,
  reach: number,
): number {
  let best = -1
  let bestDist = Infinity
  for (const h of hands) {
    if (taken.has(h.id) || !h.points?.[WRIST]) continue
    const d = Math.hypot(h.points[WRIST].x - wrist.x, h.points[WRIST].y - wrist.y)
    if (d < bestDist) {
      bestDist = d
      best = h.id
    }
  }
  if (best !== -1 && bestDist < reach * MAX_JUMP_FRACTION) return best

  // Genuinely new. Prefer the slot its handedness suggests.
  const want = side === 'right' ? 1 : 0
  if (!taken.has(want)) return want
  return want === 1 ? 0 : 1
}

/**
 * A running vote on which hand each slot is.
 *
 * The label is used for display and for the thumb geometry, so a single bad
 * frame renaming "LEFT" to "RIGHT" under the user's wrist is visible and
 * looks broken even when nothing else is wrong. A vote that decays makes the
 * label settle within a few frames and then stay put.
 */
const sideVote = new Map<number, number>()

function votedSide(id: number, saw: Side): Side {
  const prev = sideVote.get(id) ?? 0
  // Clamped so a long run of one label cannot make the other take a second to
  // win once the hand genuinely changes.
  const next = Math.max(-6, Math.min(6, prev + (saw === 'right' ? 1 : -1)))
  sideVote.set(id, next)
  return next >= 0 ? 'right' : 'left'
}

export type Hand = {
  /** Stable across frames: 0 is your left hand, 1 your right. See `slotFor`. */
  id: number
  /** Every joint, in viewport pixels, smoothed and mirrored. */
  points: { x: number; y: number }[]
  /** Cursor position — your index fingertip. */
  x: number
  y: number
  /** Where the cursor was before the fingers began closing, which is what a
   *  press is aimed at. See the note where it is set. */
  aimX: number
  aimY: number
  pinched: boolean
  /** 0..1, how closed the pinch is. Drives the reticle's tightening ring. */
  closeness: number
  gesture: Gesture
  fingers: { thumb: boolean; index: boolean; middle: boolean; ring: boolean; pinky: boolean }
  handedness: Side
  /** Rough hand size in pixels, so the renderer can scale line weight to it. */
  span: number
}

/**
 * Live hands, mutated in place.
 *
 * Deliberately not React state. This updates at camera rate and is consumed by
 * a canvas that redraws itself; routing it through the store would re-render
 * the entire HUD sixty times a second to move some lines. Same reasoning as the
 * scene's Drive object.
 */
export const hands: Hand[] = []

export const diag = {
  enabled: false,
  loading: false,
  ready: false,
  count: 0,
  fps: 0,
  gesture: '' as string,
  lastError: '',
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__hands = diag
}

let landmarker: HandLandmarker | null = null
let video: HTMLVideoElement | null = null
let running = false
/** Bumped on every enable, so a loop from a previous session stops itself. */
let generation = 0
let frames = 0
let fpsAt = 0
/** detectForVideo rejects a timestamp that does not advance, and performance.now()
 *  restarts its relationship with the model on every enable. Keep our own. */
let stamp = 0
/** CPU hand inference is steadier at a deliberate 30fps than competing with
 * WebKit's compositor at camera-rate. The cursor keeps its smoothing between
 * samples, so this removes lag without making motion look stepped. */
let lastInferenceAt = 0

/* ------------------------------------------------------------------ filters */

type Filters = {
  cursor: OneEuroPoint
  joints: OneEuroPoint[]
}

const filters = new Map<number, Filters>()

/** Recent cursor positions per hand, so a press can aim from before the pinch. */
const trails = new Map<number, { x: number; y: number; at: number }[]>()
/** When the fingers first closed, per hand — see PINCH_CONFIRM_MS. */
const pinchSince = new Map<number, number>()
/** When the finger pose last changed, per hand — see POSE_SETTLE_MS. */
const poseChangedAt = new Map<number, number>()

function filtersFor(id: number): Filters {
  let f = filters.get(id)
  if (!f) {
    f = {
      cursor: new OneEuroPoint(CURSOR_MIN_CUTOFF, CURSOR_BETA),
      joints: Array.from({ length: 21 }, () => new OneEuroPoint(SKELETON_MIN_CUTOFF, SKELETON_BETA)),
    }
    filters.set(id, f)
  }
  return f
}

/* ---------------------------------------------------------------- synthetics */

/**
 * setPointerCapture, made safe for pointers that do not exist.
 *
 * A synthetic PointerEvent carries a pointerId the browser has never issued, so
 * any element that calls setPointerCapture with it throws NotFoundError and the
 * interaction dies at the first move. That call is made by framer-motion's drag
 * and by our own resize grip — both of which we very much want a hand to be
 * able to use — and neither is somewhere we can add a try/catch.
 *
 * Capture is an optimisation, not a requirement: it exists so a drag keeps
 * receiving events after the cursor leaves the element. Our events are aimed by
 * hit-testing every frame and routed to the element that took the press, so
 * they land correctly whether or not capture was granted.
 */
let patched = false
function patchPointerCapture() {
  if (patched || typeof Element === 'undefined') return
  patched = true
  const capture = Element.prototype.setPointerCapture
  const release = Element.prototype.releasePointerCapture
  Element.prototype.setPointerCapture = function (id: number) {
    try {
      return capture.call(this, id)
    } catch {
      /* a synthetic pointer; hit-testing covers what capture would have */
    }
  }
  Element.prototype.releasePointerCapture = function (id: number) {
    try {
      return release.call(this, id)
    } catch {
      /* as above */
    }
  }
}

type Press = {
  /** What took the press, so the release and any click agree on their target. */
  captured: Element | null
  wasPinched: boolean
  /** Where the press began — for telling a click from a drag. */
  downX: number
  downY: number
}

const presses = new Map<number, Press>()
/** Arc Control turns hands into instrument dials, not a mouse cursor. Keeping
 * synthetic presses off in that mode prevents a pulse pinch from accidentally
 * clicking a panel behind the reactor. */
let pointerInteractionEnabled = true

function fire(
  el: Element | null,
  type: string,
  h: Hand,
  pressed: boolean,
  /** Defaults to the live cursor; the press passes its latched aim point. */
  at?: { x: number; y: number },
) {
  if (!el) return
  const px = at?.x ?? h.x
  const py = at?.y ?? h.y
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: px,
      clientY: py,
      // Well clear of any id the browser might issue for a real pointer.
      pointerId: 9000 + h.id,
      pointerType: 'touch',
      isPrimary: h.id === 0,
      button: 0,
      buttons: pressed ? 1 : 0,
      width: 1,
      height: 1,
      pressure: pressed ? 0.5 : 0,
    }),
  )
}

function emit(h: Hand) {
  if (!pointerInteractionEnabled) {
    releasePress(h.id, h)
    return
  }
  let p = presses.get(h.id)
  if (!p) {
    p = { captured: null, wasPinched: false, downX: h.x, downY: h.y }
    presses.set(h.id, p)
  }

  const over = document.elementFromPoint(h.x, h.y)

  if (h.pinched && !p.wasPinched) {
    /**
     * Press, aimed from where the hand was before the fingers closed.
     *
     * The fingertip travels several centimetres on its way to meeting the
     * thumb — that is what a pinch is — so the position at the instant the
     * press fires is not the position you were aiming from. Hit-testing the
     * live point made a press land below whatever you had pointed at, which is
     * why grabbing a title bar worked only when you happened to pinch straight
     * down onto it.
     */
    const aim = { x: h.aimX, y: h.aimY }
    const target = document.elementFromPoint(aim.x, aim.y) ?? over
    p.captured = target
    p.downX = aim.x
    p.downY = aim.y
    fire(target, 'pointerdown', h, true, aim)
  } else if (!h.pinched && p.wasPinched) {
    const target = p.captured ?? over
    fire(target, 'pointerup', h, false)
    // Only a press that ends roughly where it began is a click. One that
    // travelled was a drag, and a drag that also clicked would close the very
    // blade it had just finished moving.
    const travelled = Math.hypot(h.x - p.downX, h.y - p.downY)
    if (target && travelled < CLICK_SLOP && target === over) {
      target.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: h.x,
          clientY: h.y,
        }),
      )
    }
    p.captured = null
  } else {
    // While pressed, moves go to whatever took the press, so a drag survives
    // the cursor sliding off the header it grabbed.
    fire(h.pinched ? (p.captured ?? over) : over, 'pointermove', h, h.pinched)
  }

  p.wasPinched = h.pinched
}

/** Let go of anything still held. A press that outlives its hand leaves
 *  whatever was being dragged stuck to a cursor that no longer exists. */
function releasePress(id: number, at: { x: number; y: number }) {
  const p = presses.get(id)
  if (!p?.wasPinched) return
  const ghost = { id, x: at.x, y: at.y } as Hand
  fire(p.captured, 'pointerup', ghost, false)
  fire(p.captured, 'pointercancel', ghost, false)
  p.wasPinched = false
  p.captured = null
}

/* ------------------------------------------------------------------ geometry */

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y)

/**
 * Is this finger extended?
 *
 * Compared as distance from the wrist rather than by which landmark is higher
 * on screen. The y-comparison is the common recipe and it is wrong the moment
 * the hand is not upright: turn your hand sideways and every finger reads as
 * curled. Distance from the wrist is rotation-invariant, which is the property
 * the question actually needs.
 */
function isExtended(
  marks: { x: number; y: number }[],
  tip: number,
  pip: number,
): boolean {
  const wrist = marks[WRIST]
  return dist(marks[tip], wrist) > dist(marks[pip], wrist) * EXTEND_RATIO
}

/**
 * Only report a finger pose once it has held.
 *
 * Fingers pass through other shapes on the way to the one you meant: a fist
 * opening into a point spends several frames looking like a pinch, and a hand
 * relaxing looks briefly like every gesture in the list. Acting on those
 * intermediate readings is exactly what makes gesture interfaces feel
 * possessed, so a pose has to survive GESTURE_HOLD_MS before it is believed.
 *
 * A pinch is deliberately exempt. It already carries its own hysteresis, and
 * it is the one gesture where the delay would be felt directly — as a press
 * that lands late.
 */
const settling = new Map<number, { raw: Gesture; since: number; held: Gesture }>()

function stableGesture(id: number, raw: Gesture, now: number): Gesture {
  if (raw === 'pinch') {
    settling.set(id, { raw, since: now, held: raw })
    return raw
  }
  const s = settling.get(id)
  if (!s || s.raw !== raw) {
    settling.set(id, { raw, since: now, held: s?.held === 'pinch' ? 'none' : (s?.held ?? 'none') })
    return settling.get(id)!.held
  }
  if (now - s.since >= GESTURE_HOLD_MS) s.held = raw
  return s.held
}

function classify(
  fingers: Hand['fingers'],
  pinched: boolean,
): Gesture {
  if (pinched) return 'pinch'
  const { thumb, index, middle, ring, pinky } = fingers
  const up = [thumb, index, middle, ring, pinky].filter(Boolean).length
  if (index && middle && !ring && !pinky) return 'peace'
  /**
   * The framing pose — index up, thumb out, the rest curled. The corner of a
   * rectangle, the shape people already make when they mime framing a shot.
   *
   * Tested before `point`, and it has to be: a framing hand also has exactly
   * one finger extended, so the point rule would swallow it. The thumb is the
   * whole difference between "I am aiming at that" and "I am sizing this".
   */
  if (thumb && index && !middle && !ring && !pinky) return 'frame'
  if (index && !middle && !ring && !pinky) return 'point'
  if (up >= 4) return 'open'
  if (up === 0) return 'fist'
  return 'none'
}

/* -------------------------------------------------------------------- camera */

async function ensureModel() {
  if (landmarker) return landmarker
  diag.loading = true
  try {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
    landmarker = await HandLandmarker.createFromOptions(vision, {
      // CPU is deliberate: the old GPU path could terminate the app process.
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
    diag.ready = true
    return landmarker
  } finally {
    diag.loading = false
  }
}

function dropHand(i: number) {
  const at = hands.findIndex((h) => h.id === i)
  if (at === -1) return
  releasePress(i, hands[at])
  hands.splice(at, 1)
  filters.get(i)?.cursor.reset()
  filters.get(i)?.joints.forEach((f) => f.reset())
  settling.delete(i)
  sideVote.delete(i)
  trails.delete(i)
  pinchSince.delete(i)
  poseChangedAt.delete(i)
}

/**
 * The tracking loop.
 *
 * Driven by requestVideoFrameCallback where it exists: rAF runs on the
 * display's clock and will happily hand the same camera frame to the model
 * several times, burning GPU on work whose answer cannot have changed. Falls
 * back to rAF on browsers that lack it, where the only cost is some wasted
 * inference.
 */
function loop(mine: number) {
  if (!running || mine !== generation || !video || !landmarker) return

  const now = performance.now()
  if (now - lastInferenceAt < 33) {
    schedule(mine)
    return
  }
  lastInferenceAt = now
  // Strictly increasing, and independent of performance.now(): the model
  // rejects a timestamp that does not advance, and enable/disable cycles would
  // otherwise hand it the same clock twice.
  stamp += 1

  let result
  try {
    result = landmarker.detectForVideo(video, stamp)
  } catch (err) {
    diag.lastError = String((err as Error)?.message ?? err)
    result = null
  }

  const w = window.innerWidth
  const h = window.innerHeight
  const found = result?.landmarks ?? []
  const labels = result?.handedness ?? []
  diag.count = found.length
  const at = now / 1000

  const seen = new Set<number>()

  for (let k = 0; k < found.length && k < 2; k++) {
    const marks = found[k]
    if (!marks || marks.length < 21) continue

    /**
     * Which hand this is.
     *
     * This was inverted, and the inversion was reasoned rather than observed —
     * from the note in MediaPipe's older Hands docs saying handedness is
     * determined assuming a mirrored selfie image, and to swap it if your input
     * is not mirrored. We feed the raw camera frame, so on paper a swap was
     * correct. On this build of the Tasks API it is not: the label already
     * describes the actual hand, and swapping it named every hand wrongly.
     *
     * Taken at face value now, because that is what the screen showed. Kept as
     * one named constant rather than folded into the expression so that if it
     * ever needs flipping again — a different build, a genuinely mirrored
     * input — it is one line and one word, not an archaeology exercise.
     */
    const raw = labels[k]?.[0]?.categoryName ?? ''
    const named: Side = raw === 'Right' ? 'right' : 'left'
    const side: Side = SWAP_HANDEDNESS ? (named === 'right' ? 'left' : 'right') : named

    /**
     * Identity has to come from the hand, not from its position in the array.
     *
     * MediaPipe makes no promise about ordering between frames, so keying on
     * the array index means the two hands can silently swap — cursors trade
     * places, a drag in progress jumps to the other hand, and the filters that
     * smooth each hand start smoothing the other one. Keying on handedness
     * makes your left hand slot 0 for as long as it is your left hand.
     */
    const wristPx = { x: (1 - marks[WRIST].x) * w, y: marks[WRIST].y * h }
    const reach = Math.hypot(w, h)
    const i = slotFor(side, wristPx, seen, reach)
    seen.add(i)

    const f = filtersFor(i)

    // Mirrored, because the camera faces you: moving your hand right should
    // move the cursor right, not left.
    const points = marks.map((m, j) =>
      f.joints[j].filter((1 - m.x) * w, m.y * h, at),
    )

    const span = dist(points[WRIST], points[MIDDLE_MCP]) || 1
    const gap = dist(points[THUMB_TIP], points[INDEX_TIP]) / span

    let hand = hands.find((q) => q.id === i)
    if (!hand) {
      hand = {
        id: i, points,
        x: points[INDEX_TIP].x, y: points[INDEX_TIP].y,
        aimX: points[INDEX_TIP].x, aimY: points[INDEX_TIP].y,
        pinched: false, closeness: 0, gesture: 'none',
        fingers: { thumb: false, index: false, middle: false, ring: false, pinky: false },
        handedness: side, span,  // replaced by the vote below on the same frame
      }
      hands.push(hand)
    }
    hand.points = points
    hand.span = span

    /**
     * Hysteresis, then confirmation, then a settling window.
     *
     * Three filters rather than one because they catch different things. The
     * hysteresis stops a held pinch flickering on the boundary. The
     * confirmation stops a pinch that lasts a frame or two on the way between
     * poses. The settling window stops one that arrives while the hand is still
     * rearranging after a deliberate change of gesture. A press has to get past
     * all three, and an intentional pinch does so without noticing they exist.
     */
    const wantsPinch = hand.pinched ? gap < PINCH_OFF : gap < PINCH_ON
    if (wantsPinch && !hand.pinched) {
      pinchSince.set(i, pinchSince.get(i) ?? now)
    } else if (!wantsPinch) {
      pinchSince.delete(i)
    }
    const held = pinchSince.get(i)
    const settledLongEnough = now - (poseChangedAt.get(i) ?? 0) > POSE_SETTLE_MS
    const pinched = hand.pinched
      ? wantsPinch
      : wantsPinch && held !== undefined && now - held >= PINCH_CONFIRM_MS && settledLongEnough
    hand.closeness = Math.max(0, Math.min(1, 1 - (gap - PINCH_ON) / (PINCH_OFF - PINCH_ON)))

    /**
     * Where the cursor sits: the index fingertip, and nothing else.
     *
     * It used to blend toward the midpoint between thumb and finger as the
     * pinch closed, on the theory that the midpoint is what you are "really"
     * aiming when you pinch. That was wrong, and wrong in the most annoying
     * possible way: the cursor slid away from the target during the act of
     * pressing it, so a press aimed at a title bar landed a centimetre below —
     * sometimes on the blade, sometimes on nothing. It is a pointer that moves
     * while you click, which no pointer may do.
     */
    const tip = points[INDEX_TIP]
    const aimed = f.cursor.filter(tip.x, tip.y, at)
    hand.x = aimed.x
    hand.y = aimed.y

    /**
     * What the press is aimed at: where the cursor was a moment ago.
     *
     * This used to latch the position only while `closeness < 0.35`, which
     * sounded like "while the hand is open" and is not. Closeness is measured
     * against the pinch thresholds, so that condition demanded thumb and finger
     * more than half a hand-span apart — further than anyone holds a hand they
     * are pointing with. The aim point therefore froze at wherever the hand was
     * FIRST seen and never moved again, so every pinch pressed at a stale point
     * somewhere across the screen. Nothing could be focused, grabbed or closed.
     *
     * A trail has no such cliff: it always records, and the press simply reads
     * back AIM_LAG_MS, which is the distance a fingertip covers on its way to
     * meeting the thumb.
     */
    const trail = trails.get(i) ?? []
    trail.push({ x: aimed.x, y: aimed.y, at: now })
    while (trail.length > 1 && now - trail[0].at > TRAIL_MS) trail.shift()
    trails.set(i, trail)

    if (!pinched) {
      const want = now - AIM_LAG_MS
      // The newest sample that is still old enough; the oldest we have if the
      // hand has only just appeared.
      let pick = trail[0]
      for (const p of trail) if (p.at <= want) pick = p
      hand.aimX = pick.x
      hand.aimY = pick.y
    }
    hand.pinched = pinched

    hand.fingers = {
      // The thumb never straightens the way the fingers do, so it is measured
      // against its own base joint rather than by the same ratio.
      thumb: dist(points[THUMB_TIP], points[WRIST]) > dist(points[THUMB_MCP], points[WRIST]) * 1.35
        || dist(points[THUMB_TIP], points[INDEX_PIP]) > span * 1.1,
      index: isExtended(points, INDEX_TIP, INDEX_PIP),
      middle: isExtended(points, MIDDLE_TIP, MIDDLE_PIP),
      ring: isExtended(points, RING_TIP, RING_PIP),
      pinky: isExtended(points, PINKY_TIP, PINKY_PIP),
    }
    const wasGesture = hand.gesture
    hand.gesture = stableGesture(i, classify(hand.fingers, pinched), now)
    // A change of pose starts the settling window. Pinch is not counted: it is
    // the thing being protected, not a transition to recover from.
    if (hand.gesture !== wasGesture && hand.gesture !== 'pinch' && wasGesture !== 'pinch') {
      poseChangedAt.set(i, now)
    }
    hand.handedness = votedSide(i, side)

    emit(hand)
  }

  // Anything not seen this frame has left the picture.
  for (const id of [0, 1]) if (!seen.has(id)) dropHand(id)

  diag.gesture = hands
    .map((q) => `${q.handedness === 'right' ? 'R' : 'L'}:${q.gesture}`)
    .join(' + ')

  frames++
  if (now - fpsAt > 1000) {
    diag.fps = Math.round((frames * 1000) / (now - fpsAt))
    frames = 0
    fpsAt = now
  }

  schedule(mine)
}

function schedule(mine: number) {
  if (!video) return
  if (typeof video.requestVideoFrameCallback === 'function') {
    video.requestVideoFrameCallback(() => loop(mine))
  } else {
    requestAnimationFrame(() => loop(mine))
  }
}

/** Turn the camera on and start tracking. Safe to call twice. */
export async function enableHands(): Promise<void> {
  if (running) return
  patchPointerCapture()
  const mine = ++generation
  try {
    /**
     * One shared camera, refcounted — see camera.ts.
     *
     * This used to open its own stream. A second getUserMedia makes Chrome drop
     * the first, so hand tracking and the camera blade could not both exist:
     * whichever started last blinded the other, and the symptom appeared in the
     * feature that had done nothing wrong.
     */
    video = await holdCamera()
    await ensureModel()

    running = true
    diag.enabled = true
    fpsAt = performance.now()
    schedule(mine)
  } catch (err) {
    diag.lastError = String((err as Error)?.message ?? err)
    disableHands()
    throw err
  }
}

/** Camera off, tracking stopped, anything held released. */
export function disableHands(): void {
  running = false
  generation++
  diag.enabled = false
  diag.count = 0
  diag.fps = 0
  diag.gesture = ''
  for (const h of hands) releasePress(h.id, h)
  hands.length = 0
  presses.clear()
  filters.clear()
  settling.clear()
  sideVote.clear()
  trails.clear()
  pinchSince.clear()
  poseChangedAt.clear()
  // Give the hold back rather than tearing the stream down: the camera blade
  // may still be showing it, and stopping the tracks would blank it.
  if (video) {
    video = null
    releaseCamera()
  }
}

/**
 * Both hands framing, and how big the box between them is.
 *
 * The gesture is the one people already make to mime a rectangle: index up,
 * thumb out, two corners held apart. Pulling them apart makes the box bigger;
 * bringing them together makes it smaller.
 *
 * Depth comes free. Moving both hands toward the camera makes everything about
 * them larger in the image, including the distance between them, so leaning in
 * grows the box and leaning back shrinks it — without a single line about z,
 * which is the noisiest number MediaPipe reports.
 *
 * The corner is measured at the crook between thumb and index rather than at
 * the index tip, because that is where the corner of the imagined rectangle
 * actually is, and it is the point that stays still while the fingers spread.
 *
 * Published as a plain distance. This file does not know what is on screen and
 * has no business deciding that a bigger box means a bigger blade.
 */
/**
 * How many hands are currently pinching.
 *
 * A single pinch is a grab. Two at once is not two grabs — it is somebody doing
 * something with both hands, and whatever that is, it is not "drag this blade
 * to two places at once". Consumers use this to stand down rather than fight
 * each other for the same object.
 */
export function pinchCount(): number {
  return hands.filter((h) => h.pinched).length
}

export function frameSpan(): number | null {
  const framing = hands.filter((h) => h.gesture === 'frame')
  if (framing.length < 2) return null
  const [a, b] = framing
  const corner = (h: Hand) => ({
    x: (h.points[THUMB_TIP].x + h.points[INDEX_TIP].x) / 2,
    y: (h.points[THUMB_TIP].y + h.points[INDEX_TIP].y) / 2,
  })
  const ca = corner(a)
  const cb = corner(b)
  return Math.hypot(ca.x - cb.x, ca.y - cb.y)
}

/** Values for the deliberate two-open-palm Arc Control pose. */
export function twoPalmControl(): { span: number; angle: number; y: number } | null {
  // Requiring an exact "open palm" classification made the most important
  // control vanish whenever one finger was partly out of the camera frame.
  // Two tracked hands are the signal; their position is much more reliable
  // than naming a pose.
  if (hands.length < 2) return null
  const [a, b] = hands
  const ax = a.points[WRIST]?.x
  const ay = a.points[WRIST]?.y
  const bx = b.points[WRIST]?.x
  const by = b.points[WRIST]?.y
  if (![ax, ay, bx, by].every(Number.isFinite)) return null
  return {
    span: Math.hypot(ax - bx, ay - by),
    angle: Math.atan2(by - ay, bx - ax),
    y: (ay + by) / 2,
  }
}

/** Enable ordinary pinch-to-click only outside deliberate Arc Control. */
export function setPointerInteractionEnabled(enabled: boolean) {
  pointerInteractionEnabled = enabled
  if (!enabled) {
    for (const hand of hands) releasePress(hand.id, hand)
  }
}

/**
 * Two fingers up, moved vertically — how far, since the pose began.
 *
 * Scrolling needed its own gesture once pinch became "grab this blade". A pinch
 * cannot mean both grab and scroll, and grabbing is what people reach for
 * first: they see a thing and try to pick it up. So scrolling gets the pose
 * that is deliberate and hard to make by accident.
 *
 * Returns pixels travelled since the two fingers went up, or null when nobody
 * is holding the pose. Published as a distance rather than as a scroll for the
 * same reason as twoHandSpan — this file does not know what is on screen.
 */
let peaceFrom: { id: number; y: number } | null = null

export function peaceScroll(): number | null {
  const hand = hands.find((h) => h.gesture === 'peace')
  if (!hand) {
    peaceFrom = null
    return null
  }
  if (!peaceFrom || peaceFrom.id !== hand.id) {
    peaceFrom = { id: hand.id, y: hand.y }
    return 0
  }
  return hand.y - peaceFrom.y
}

export const handsRunning = () => running
