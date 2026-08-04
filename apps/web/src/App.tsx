import { useEffect, useState } from 'react'
import './app.css'
import { EarthGlobe } from './components/EarthGlobe'

function formatClock(date: Date, utc: boolean) {
  const part = (value: number) => String(value).padStart(2, '0')
  const hours = utc ? date.getUTCHours() : date.getHours()
  const minutes = utc ? date.getUTCMinutes() : date.getMinutes()
  const seconds = utc ? date.getUTCSeconds() : date.getSeconds()

  return `${part(hours)}:${part(minutes)}:${part(seconds)}`
}

export function App() {
  const [listening, setListening] = useState(false)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(clock)
  }, [])

  return (
    <main className="app-shell">
      <section className="voice-console" aria-label="Earth Assistant voice console">
        <aside className="console-controls">
          <header className="console-title">
            <p>Voice console</p>
            <h1>Earth Assistant</h1>
          </header>

          <button className="control-button" disabled={listening} onClick={() => setListening(true)} type="button">Start</button>
          <button className="control-button" disabled={!listening} onClick={() => setListening(false)} type="button">Stop</button>
          <button className="control-button" type="button">Restart</button>

          <div className="console-meta">
            <p className="status"><span className={`status-dot${listening ? ' status-dot--listening' : ''}`} aria-hidden="true" />{listening ? 'Listening' : 'Standby'}</p>
            <p className="clock">Local {formatClock(now, false)} · UTC {formatClock(now, true)}</p>
          </div>
        </aside>

        <section className="console-output" aria-label="Voice transcript">
          <EarthGlobe listening={listening} />
          <div className="transcript" aria-live="polite">
            <span>Press Start and speak — your words appear here.</span>
          </div>
        </section>
      </section>
    </main>
  )
}
