import { memo, useEffect, useMemo, useRef } from 'react'
import { AnimatePresence, motion, type Variants } from 'framer-motion'
import { useStore, type Panel } from '../store'
import { sanitisePanelHtml } from './sanitise'

/**
 * Heads-up display panels.
 *
 * The markup inside each panel is written by JARVIS, not by this file — he
 * composes the layout for whatever he's showing and picks how it arrives. What
 * lives here is the frame, the safety boundary, and the motion vocabulary.
 */



/** How a panel arrives. The model picks one per panel. */
const VARIANTS: Record<Panel['anim'], Variants> = {
  materialise: {
    hidden: { opacity: 0, scaleY: 0.86, filter: 'blur(4px)' },
    shown: { opacity: 1, scaleY: 1, filter: 'blur(0px)' },
  },
  sweep: {
    hidden: { opacity: 0, x: 44 },
    shown: { opacity: 1, x: 0 },
  },
  unfold: {
    hidden: { opacity: 0, scaleY: 0.2, originY: 0 },
    shown: { opacity: 1, scaleY: 1, originY: 0 },
  },
  stagger: {
    hidden: { opacity: 0, y: 14 },
    shown: { opacity: 1, y: 0 },
  },
  snap: {
    // Overshoots to 1.03 then settles — reads as a hard cut rather than a glide.
    hidden: { opacity: 0, scale: 1.04 },
    shown: { opacity: 1, scale: 1 },
  },
}

const SPRING = { type: 'spring' as const, stiffness: 300, damping: 28 }

/**
 * A dead <img> at width:100% renders as a large blank rectangle that reads as a
 * broken interface, and a <video> that never loaded is a black one. Replace
 * either with a small caption.
 *
 * Now that remote media is proxied there is a third way to fail on top of the
 * two that always existed (a disk path the bridge can't read, and an element
 * whose src the sanitiser removed — which has no src at all, so it reports
 * complete with a natural width of 0): the bridge itself refusing the fetch,
 * because the host blocked it, the content-type wasn't media, or the URL
 * resolved somewhere on the LAN.
 *
 * The sanitiser strips `onerror`, so the handler has to be attached here.
 *
 * Flagged per element rather than per call: the body is only re-parsed when the
 * markup changes, but nothing stops this running twice over the same nodes, and
 * a second listener would replace an already-replaced image.
 */
function watchMedia(node: HTMLDivElement | null) {
  if (!node) return

  node.querySelectorAll('img').forEach((img) => {
    if (img.dataset.watched) return
    img.dataset.watched = '1'
    const fail = () => replaceWithNote(img, 'image unavailable')
    if (img.complete && img.naturalWidth === 0) fail()
    else img.addEventListener('error', fail, { once: true })
  })

  node.querySelectorAll('video').forEach((video) => {
    if (video.dataset.watched) return
    video.dataset.watched = '1'
    const fail = () => replaceWithNote(video, 'video unavailable')
    // A <video> the sanitiser stripped the src from never attempts a load, so
    // it never errors either — it just sits there as a black rectangle. The
    // <img> equivalent is caught by naturalWidth; this is the check that stands
    // in for it.
    if (!video.hasAttribute('src') && !video.querySelector('source[src]')) {
      fail()
      return
    }
    // Captured rather than bubbled. When the sources are <source> children the
    // media element itself never fires `error` — each child does, and error
    // events don't bubble — so listening on the parent alone would miss exactly
    // the shape the design system encourages. Capture sees both.
    video.addEventListener('error', fail, { capture: true, once: true })
  })
}

function replaceWithNote(el: Element, text: string) {
  const note = document.createElement('span')
  note.className = 'hud-caption hud-dim'
  note.textContent = text
  el.replaceWith(note)
}

/**
 * Memoised because the HUD around it re-renders with the microphone level —
 * roughly sixty times a second — and none of that has anything to do with what
 * is on a card. Panels are immutable once pushed, so identity comparison is
 * enough, and it is what keeps the sanitise pass below from running per frame.
 */
const Card = memo(function Card({ panel }: { panel: Panel }) {
  const html = useMemo(() => sanitisePanelHtml(panel.html ?? ''), [panel.html])

  // An empty body renders as a large blank rectangle, which looks like the
  // interface is broken rather than like nothing was sent. Say so instead.
  //
  // A panel whose entire content is a video or an embed has no text and no
  // <img>, and was being declared empty and thrown away — the caption said "no
  // content returned" while holding the thing it had been asked to show.
  const empty = useMemo(
    () => !html.replace(/<[^>]*>/g, '').trim() && !/<(?:img|video|iframe)\b/i.test(html),
    [html],
  )

  const body = useRef<HTMLDivElement>(null)

  // In an effect, so it is one line in the console per bad panel rather than
  // one per frame for as long as the panel is up.
  useEffect(() => {
    if (empty) console.warn('[jarvis] empty panel body', panel.title, panel.html)
  }, [panel, empty])

  // After the markup lands, and again only when the markup changes. As a
  // callback ref this re-queried every image on every render of the card.
  useEffect(() => {
    watchMedia(body.current)
  }, [html])

  return (
    <motion.section
      className={`panel panel-${panel.accent}`}
      variants={VARIANTS[panel.anim] ?? VARIANTS.materialise}
      initial="hidden"
      animate="shown"
      exit={{ opacity: 0, filter: 'blur(6px)', transition: { duration: 0.3 } }}
      transition={panel.anim === 'snap' ? { duration: 0.12 } : SPRING}
      // Deliberately no `layout` prop. Re-flowing the stack when a sibling
      // enters or leaves looks nice for one frame and flickers for the rest —
      // layout projection re-measures continuously and fights the container.
      // The gap between cards is fixed, so there is nothing to animate.
    >
      <span className="pk pk-tl" />
      <span className="pk pk-tr" />
      <span className="pk pk-bl" />
      <span className="pk pk-br" />

      {/* The scan wipe — a band that travels the height of the card once. */}
      <motion.span
        className="p-wipe"
        initial={{ y: '-100%', opacity: 0.9 }}
        animate={{ y: '300%', opacity: 0 }}
        transition={{ duration: 0.7, ease: 'easeOut' }}
      />

      <header className="p-head">
        <span className="p-title">{panel.title}</span>
      </header>

      {/* Sanitised above; `stagger` is handled in CSS so it applies to whatever
          children the model happened to author. */}
      {empty ? (
        <p className="p-empty">no content returned</p>
      ) : (
        <div
          ref={body}
          className={panel.anim === 'stagger' ? 'p-body p-stagger' : 'p-body'}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </motion.section>
  )
})

/**
 * Memoised for the same reason as Card: it takes no props, so it re-renders
 * only when the panel list itself changes rather than every time the HUD
 * repaints around it.
 */
export const Panels = memo(function Panels() {
  const panels = useStore((s) => s.panels)

  const slots = {
    right: panels.filter((p) => p.slot === 'right' || !p.slot),
    left: panels.filter((p) => p.slot === 'left'),
    wide: panels.filter((p) => p.slot === 'wide'),
  }

  return (
    <>
      {(['right', 'left', 'wide'] as const).map((slot) => (
        <div key={slot} className={`panels panels-${slot}`}>
          <AnimatePresence>
            {slots[slot].map((p) => (
              <Card key={p.id} panel={p} />
            ))}
          </AnimatePresence>
        </div>
      ))}
    </>
  )
})
