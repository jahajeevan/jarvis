/**
 * The 1€ filter — Casiez, Roussel & Vogel, CHI 2012.
 *
 * Hand tracking has two problems that pull in opposite directions. A still hand
 * is not still: the landmarks jitter by several pixels a frame, and a cursor
 * that shivers cannot be aimed at anything small. A moving hand needs the
 * opposite treatment: any smoothing strong enough to kill that jitter also adds
 * lag, and a cursor that trails your finger feels broken in a way jitter does
 * not.
 *
 * A fixed low-pass filter — the one-line `x += (target - x) * k` — has to pick
 * one of those to be bad at. This picks neither. It estimates the speed of the
 * signal and adapts its own cutoff to it: smooth hard when the hand is nearly
 * still, barely smooth at all when it is moving fast. Jitter is a problem at
 * low speed and lag is a problem at high speed, and this is the filter that
 * knows which one it is currently facing.
 *
 * Two parameters worth understanding, because they are the entire tuning
 * surface:
 *
 *   minCutoff — the floor. Lower is smoother when still, and slower to respond.
 *               Raise it if the cursor feels sluggish; lower it if it shivers.
 *   beta      — how aggressively the cutoff opens up with speed. Raise it if
 *               fast movements lag behind the hand; lower it if fast movements
 *               feel twitchy.
 *
 * The published tuning advice is to set beta to 0, lower minCutoff until the
 * jitter at rest is acceptable, then raise beta until the lag during fast
 * movement is acceptable. That is how the defaults in hands.ts were chosen.
 */

const TAU = 2 * Math.PI

/** Smoothing factor for a given cutoff frequency and sample period. */
function alphaFor(cutoff: number, dt: number): number {
  const tau = 1 / (TAU * cutoff)
  return 1 / (1 + tau / dt)
}

class LowPass {
  private value: number | null = null

  filter(x: number, alpha: number): number {
    this.value = this.value === null ? x : alpha * x + (1 - alpha) * this.value
    return this.value
  }

  get last(): number | null {
    return this.value
  }

  reset() {
    this.value = null
  }
}

export class OneEuro {
  private x = new LowPass()
  private dx = new LowPass()
  private lastAt: number | null = null

  private minCutoff: number
  private beta: number
  /** Cutoff for the speed estimate itself, which is noisier than the signal. */
  private dCutoff: number

  // Written out rather than as constructor parameter properties: the project
  // compiles with `erasableSyntaxOnly`, which forbids any TypeScript syntax
  // that emits code rather than simply being stripped.
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }

  /** @param at timestamp in seconds. */
  filter(x: number, at: number): number {
    if (this.lastAt === null) {
      this.lastAt = at
      this.dx.filter(0, alphaFor(this.dCutoff, 1 / 60))
      return this.x.filter(x, 1)
    }

    // Guard the sample period. A tab that was backgrounded returns with a dt of
    // several seconds, which drives alpha to ~1 and lets a single stale frame
    // snap the filter to it; a dt of zero divides by nothing at all.
    const dt = Math.min(Math.max(at - this.lastAt, 1 / 240), 1 / 5)
    this.lastAt = at

    const prev = this.x.last
    const speed = prev === null ? 0 : (x - prev) / dt
    const edx = this.dx.filter(speed, alphaFor(this.dCutoff, dt))

    // The whole idea, in one line: the faster the signal is moving, the higher
    // the cutoff, and the less it is smoothed.
    const cutoff = this.minCutoff + this.beta * Math.abs(edx)
    return this.x.filter(x, alphaFor(cutoff, dt))
  }

  reset() {
    this.x.reset()
    this.dx.reset()
    this.lastAt = null
  }
}

/** A 1€ filter per axis, for filtering a point. */
export class OneEuroPoint {
  private fx: OneEuro
  private fy: OneEuro

  constructor(minCutoff: number, beta: number, dCutoff = 1.0) {
    this.fx = new OneEuro(minCutoff, beta, dCutoff)
    this.fy = new OneEuro(minCutoff, beta, dCutoff)
  }

  filter(x: number, y: number, at: number): { x: number; y: number } {
    return { x: this.fx.filter(x, at), y: this.fy.filter(y, at) }
  }

  reset() {
    this.fx.reset()
    this.fy.reset()
  }
}
