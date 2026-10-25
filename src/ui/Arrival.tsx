import type { CSSProperties } from 'react'

export type ArrivalStage = 'idle' | 'handoff' | 'arrival'

/** The engineered aperture between the boot film and the live reactor. */
export function Arrival({ stage }: { stage: ArrivalStage }) {
  if (stage === 'idle') return null
  const arrival = stage === 'arrival'
  return (
    <div className={`arrival arrival--${stage}`} aria-hidden="true">
      <div className="arrival-vignette" />
      <div className="arrival-axis arrival-axis-x" />
      <div className="arrival-axis arrival-axis-y" />
      <div className="arrival-aperture">
        <div className="arrival-halo arrival-halo-a" />
        <div className="arrival-halo arrival-halo-b" />
        <div className="arrival-halo arrival-halo-c" />
        <div className="arrival-shutter">
          {Array.from({ length: 12 }, (_, index) => (
            <i key={index} style={{ '--segment': index } as CSSProperties} />
          ))}
        </div>
        <div className="arrival-core"><span /></div>
      </div>
      <div className="arrival-readout arrival-readout-left">
        <span>{arrival ? 'CONTAINMENT ARRAY' : 'REACTOR BAY'}</span>
        <b>{arrival ? 'SYNCHRONISING' : 'SEALED'}</b>
      </div>
      <div className="arrival-readout arrival-readout-right">
        <span>POWER BUS</span><b>{arrival ? 'NOMINAL' : 'ISOLATED'}</b>
      </div>
    </div>
  )
}
