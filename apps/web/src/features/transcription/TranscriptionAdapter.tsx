import { useEffect, useReducer, useState } from "react";
import { EarthGlobe } from "../../components/EarthGlobe";
import { LocalWhisperEngine } from "@voice/local-whisper-engine";
import { SessionController, type EngineFactory, type MicrophoneFactory } from "./sessionController";
import { createSessionState, sessionReducer } from "./sessionReducer";

const LANGUAGES = [["en-US", "English (US)"], ["vi-VN", "Vietnamese"], ["es-ES", "Spanish"], ["zh-CN", "Chinese"]] as const;
interface TranscriptionAdapterProps { initialLanguages?: readonly string[]; engineFactory?: EngineFactory; microphoneFactory?: MicrophoneFactory; }

function formatClock(date: Date, utc: boolean) {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${part(utc ? date.getUTCHours() : date.getHours())}:${part(utc ? date.getUTCMinutes() : date.getMinutes())}:${part(utc ? date.getUTCSeconds() : date.getSeconds())}`;
}

export function TranscriptionAdapter({ initialLanguages = [], engineFactory, microphoneFactory }: TranscriptionAdapterProps) {
  const [state, dispatch] = useReducer(sessionReducer, "transcription-idle", createSessionState);
  const [candidateLanguages, setCandidateLanguages] = useState<readonly string[]>(initialLanguages);
  const [selectionError, setSelectionError] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [backpressureWarning, setBackpressureWarning] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number>();
  const [now, setNow] = useState(() => new Date());

  // Constructed lazily on first render rather than from props/state:
  // SessionController's constructor is pure (only assigns fields, no
  // subscriptions or timers), so it's safe for React to invoke this
  // initializer more than once (e.g. Strict Mode) and keep only one result.
  // Disposal still needs an effect, since that's a side effect on unmount.
  const [controller] = useState<SessionController>(() => new SessionController({
    dispatch,
    engineFactory: engineFactory ?? (() => new LocalWhisperEngine({ onProgress: setLoadProgress })),
    microphoneFactory,
    onLocalError: setLocalError,
    onBackpressureWarning: setBackpressureWarning,
  }));
  useEffect(() => {
    return () => { void controller.dispose(); };
  }, [controller]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  const error = selectionError ?? localError ?? state.fatalError?.message;
  const listening = !error && (starting || state.engineState === "listening" || state.engineState === "draining");
  const hasValidSelection = candidateLanguages.length >= 1 && candidateLanguages.length <= 4 && new Set(candidateLanguages).size === candidateLanguages.length;
  const toggleLanguage = (tag: string) => {
    setSelectionError(undefined);
    setCandidateLanguages((selected) => selected.includes(tag) ? selected.filter((language) => language !== tag) : [...selected, tag]);
  };
  const run = async (operation: () => Promise<unknown>) => {
    if (!hasValidSelection) { setSelectionError("Select between 1 and 4 unique languages"); return; }
    setSelectionError(undefined); setLocalError(undefined); setBackpressureWarning(undefined); setLoadProgress(undefined); setStarting(true);
    try { await operation(); } catch { /* controller emits the normalized local error */ } finally { setStarting(false); }
  };

  return (
    <main className="app-shell">
      <section className="voice-console" aria-label="Earth Assistant voice console">
        <aside className="console-controls">
          <header className="console-title"><p>Voice console</p><h1>Earth Assistant</h1></header>
          <div aria-label="Candidate languages">{LANGUAGES.map(([tag, label]) => <button aria-pressed={candidateLanguages.includes(tag)} className="control-button" key={tag} onClick={() => toggleLanguage(tag)} type="button">{label}</button>)}</div>
          <button className="control-button" disabled={listening} onClick={() => void run(() => controller.start(candidateLanguages))} type="button">Start</button>
          <button className="control-button" disabled={!listening} onClick={() => { setStarting(false); setLoadProgress(undefined); void controller.stop(); }} type="button">Stop</button>
          <button className="control-button" onClick={() => void run(() => controller.clearAndRestart(candidateLanguages))} type="button">Clear &amp; Restart</button>
          <div className="console-meta"><p aria-atomic="true" aria-live="polite" className="status" role="status"><span className={`status-dot${listening ? " status-dot--listening" : ""}`} aria-hidden="true" />{listening ? "Listening" : "Standby"}</p><p className="engine-mode">Local transcription (on this device)</p><p className="clock">Local {formatClock(now, false)} · UTC {formatClock(now, true)}</p></div>
        </aside>
        <section className="console-output" aria-label="Voice transcript">
          <EarthGlobe listening={listening} />
          <div className="transcript" aria-live="polite">
            {state.segments.length === 0 ? <span>Press Start and speak — your words appear here.</span> : state.segments.map((segment) => <p key={segment.id}><span>{segment.text}</span> <small>{segment.language.tag}</small></p>)}
            {starting && <p>Preparing local model{loadProgress === undefined ? "…" : ` ${Math.round(loadProgress * 100)}%`}</p>}
            {state.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}
            {backpressureWarning && <p>{backpressureWarning}</p>}
          </div>
          {error && <p role="alert">{error}</p>}
        </section>
      </section>
    </main>
  );
}
