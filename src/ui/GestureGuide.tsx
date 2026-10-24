import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

/**
 * What your hands can do.
 *
 * A touchless interface has the same problem a voice interface has: no menus,
 * no buttons, nothing on screen that tells you what is possible. The
 * suggestions strip solves that for speech, and this is its equivalent for
 * hands — shown when the camera comes on, when you would actually be wondering.
 *
 * It fades once you have used it. A legend that stays up forever is clutter,
 * and the moment you have successfully pinched something you no longer need to
 * be told how; but it comes back whenever the camera is turned on again,
 * because that is when you have forgotten.
 */

const MOVES: { gesture: string; hand: string; does: string }[] = [
  { gesture: 'two hands', hand: '✋ ✋', does: 'hold still briefly to calibrate' },
  { gesture: 'spread', hand: '↔', does: 'grow or shrink the Arc field' },
  { gesture: 'lift', hand: '↑', does: 'raise or lower reactor power' },
  { gesture: 'tilt', hand: '╱', does: 'change the Arc spin' },
  { gesture: 'one pinch', hand: '🤏', does: 'release an Arc pulse' },
  { gesture: 'two pinches', hand: '🤏 🤏', does: 'hold briefly to recalibrate' },
]

export function GestureGuide({ live }: { live: boolean }) {
  const [show, show_] = useState(false)

  useEffect(() => {
    if (!live) {
      show_(false)
      return
    }
    show_(true)
    return undefined
  }, [live])

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="gguide"
          initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: 8, filter: 'blur(6px)', transition: { duration: 0.5 } }}
          transition={{ type: 'spring', stiffness: 260, damping: 28 }}
        >
          <div className="gguide-head">HAND CONTROL</div>
          {MOVES.map((m) => (
            <div key={m.gesture} className="gguide-row">
              <span className="gguide-icon">{m.hand}</span>
              <span className="gguide-name">{m.gesture}</span>
              <span className="gguide-does">{m.does}</span>
            </div>
          ))}
          <div className="gguide-foot">
            camera stays local · <kbd>K</kbd> exits Arc Control
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
