import { useEffect, useRef, useState } from 'react'
import { useStore, type UiEffect } from '../store'

/**
 * One-shot frame effects, fired by JARVIS.
 *
 * These are punctuation, not state: a shockwave when something lands, a tear
 * when something goes wrong. So the overlay only exists while an effect is
 * playing — mounting it permanently would leave a full-frame element in the
 * tree for the entire session for the sake of half a second of animation.
 *
 * Every effect is a CSS keyframe on a freshly mounted node. That is what makes
 * a repeat fire work: `at` is in the key, so asking for 'glitch' twice in a row
 * remounts the node and the animation starts from zero, where re-applying the
 * same class to a live element would do nothing at all.
 *
 * 'shake' is the odd one out. Jolting the frame means moving the HUD itself,
 * which this component does not own, so it borrows it — the class goes on the
 * `.hud` ancestor for the duration and comes off again, including on unmount.
 * A DOM reach-up beats hoisting effect bookkeeping into Hud.tsx just so one of
 * five effects can be expressed as a prop.
 */

/** How long each effect's keyframes run. Kept in step with index.css. */
const DURATION: Record<UiEffect['kind'], number> = {
  glitch: 620,
  pulse: 900,
  scan: 900,
  shake: 520,
  flash: 480,
  winter: 1700,
}

export function Effects() {
  const effect = useStore((s) => s.ui.effect)
  const [live, setLive] = useState<UiEffect | null>(null)
  const root = useRef<HTMLDivElement | null>(null)

  const kind = effect?.kind
  const at = effect?.at ?? 0

  // Depends on the timestamp rather than the object, which is the whole point
  // of `at` existing: five 'flash' commands in a row are five flashes.
  useEffect(() => {
    if (!kind) return
    setLive({ kind, at })
    const done = setTimeout(() => setLive(null), DURATION[kind] ?? 600)
    return () => clearTimeout(done)
  }, [kind, at])

  useEffect(() => {
    if (!live || live.kind !== 'shake') return
    const hud = root.current?.closest('.hud')
    if (!hud) return
    hud.classList.add('fx-shaking')
    const done = setTimeout(() => hud.classList.remove('fx-shaking'), DURATION.shake)
    return () => {
      clearTimeout(done)
      hud.classList.remove('fx-shaking')
    }
  }, [live])

  if (!live) return null

  return (
    <div className="fx" ref={root} aria-hidden="true">
      <div key={`${live.kind}-${live.at}`} className={`fx-play fx-${live.kind}`}>
        {/* Slices for the tear, rings for the shockwave. The rest of the
            effects are a single painted layer and need no children. */}
        {live.kind === 'glitch' && (
          <>
            <span className="fx-slice" />
            <span className="fx-slice" />
            <span className="fx-slice" />
          </>
        )}
        {live.kind === 'pulse' && (
          <>
            <span className="fx-wave" />
            <span className="fx-wave" />
          </>
        )}
        {live.kind === 'winter' && (
          <>
            {Array.from({ length: 18 }, (_, index) => <span className="fx-flake" key={index} />)}
            <span className="fx-frost" />
          </>
        )}
      </div>
    </div>
  )
}
