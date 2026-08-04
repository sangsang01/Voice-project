type EarthGlobeProps = {
  listening: boolean
}

export function EarthGlobe({ listening }: EarthGlobeProps) {
  return (
    <div
      aria-label={listening ? 'Earth globe rotating quickly' : 'Earth globe rotating slowly'}
      className={`earth-globe${listening ? ' earth-globe--listening' : ''}`}
      role="img"
    >
      <div className="earth-globe__surface" />
      <div className="earth-globe__clouds" />
      <div className="earth-globe__atmosphere" />
    </div>
  )
}
