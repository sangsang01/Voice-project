import { useEffect, useReducer, useRef, useState } from "react";
import { EarthGlobe } from "../../components/EarthGlobe";
import { CloudConsentDialog } from "./CloudConsentDialog";
import { SessionController, type EngineFactory, type MicrophoneFactory } from "./sessionController";
import { createSessionState, sessionReducer } from "./sessionReducer";

const LANGUAGES = [["en-US", "English (US)"], ["vi-VN", "Vietnamese"], ["es-ES", "Spanish"], ["zh-CN", "Chinese"]] as const;
interface TranscriptionAdapterProps { initialLanguages?: readonly string[]; engineFactory?: EngineFactory; microphoneFactory?: MicrophoneFactory; onCloudConsent?(): void; }

function formatClock(date: Date, utc: boolean) {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${part(utc ? date.getUTCHours() : date.getHours())}:${part(utc ? date.getUTCMinutes() : date.getMinutes())}:${part(utc ? date.getUTCSeconds() : date.getSeconds())}`;
}

export function TranscriptionAdapter({ initialLanguages = [], engineFactory, microphoneFactory, onCloudConsent }: TranscriptionAdapterProps) {
  const [state, dispatch] = useReducer(sessionReducer, "transcription-idle", createSessionState);
  const [candidateLanguages, setCandidateLanguages] = useState<readonly string[]>(initialLanguages);
  const [selectionError, setSelectionError] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [backpressureWarning, setBackpressureWarning] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const controllerRef = useRef<SessionController | null>(null);
  if (controllerRef.current == null) controllerRef.current = new SessionController({
    dispatch,
    engineFactory,
    microphoneFactory,
    onLocalError: setLocalError,
    onBackpressureWarning: setBackpressureWarning,
  });

  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 1000);
    return () => { window.clearInterval(clock); void controllerRef.current?.dispose(); };
  }, []);

  const listening = starting || state.engineState === "listening" || state.engineState === "draining";
  const hasValidSelection = candidateLanguages.length >= 1 && candidateLanguages.length <= 4 && new Set(candidateLanguages).size === candidateLanguages.length;
  const error = selectionError ?? localError ?? state.fatalError?.message;
  const toggleLanguage = (tag: string) => {
    setSelectionError(undefined);
    setCandidateLanguages((selected) => selected.includes(tag) ? selected.filter((language) => language !== tag) : [...selected, tag]);
  };
  const run = async (operation: () => Promise<unknown>) => {
    if (!hasValidSelection) { setSelectionError("Select between 1 and 4 unique languages"); return; }
    setSelectionError(undefined); setLocalError(undefined); setBackpressureWarning(undefined); setStarting(true);
    try { await operation(); } catch { /* controller emits the normalized local error */ } finally { setStarting(false); }
  };

  return (
    <main className="app-shell">
      <section className="voice-console" aria-label="Earth Assistant voice console">
        <aside className="console-controls">
          <header className="console-title"><p>Voice console</p><h1>Earth Assistant</h1></header>
          <div aria-label="Candidate languages">{LANGUAGES.map(([tag, label]) => <button aria-pressed={candidateLanguages.includes(tag)} className="control-button" key={tag} onClick={() => toggleLanguage(tag)} type="button">{label}</button>)}</div>
          <button className="control-button" disabled={listening} onClick={() => void run(() => controllerRef.current!.start(candidateLanguages))} type="button">Start</button>
          <button className="control-button" disabled={!listening} onClick={() => void controllerRef.current!.stop()} type="button">Stop</button>
          <button className="control-button" onClick={() => void run(() => controllerRef.current!.clearAndRestart(candidateLanguages))} type="button">Clear &amp; Restart</button>
          <button className="control-button" onClick={() => setCloudDialogOpen(true)} type="button">Use cloud transcription</button>
          <div className="console-meta"><p aria-atomic="true" aria-live="polite" className="status" role="status"><span className={`status-dot${listening ? " status-dot--listening" : ""}`} aria-hidden="true" />{listening ? "Listening" : "Standby"}</p><p className="clock">Local {formatClock(now, false)} · UTC {formatClock(now, true)}</p></div>
        </aside>
        <section className="console-output" aria-label="Voice transcript">
          <EarthGlobe listening={listening} />
          <div className="transcript" aria-live="polite">
            {state.segments.length === 0 ? <span>Press Start and speak — your words appear here.</span> : state.segments.map((segment) => <p key={segment.id}><span>{segment.text}</span> <small>{segment.language.tag}</small></p>)}
            {starting && <p>Preparing local model…</p>}
            {state.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}
            {backpressureWarning && <p>{backpressureWarning}</p>}
          </div>
          {error && <p role="alert">{error}</p>}
        </section>
      </section>
      <CloudConsentDialog onCancel={() => setCloudDialogOpen(false)} onConfirm={() => { setCloudDialogOpen(false); onCloudConsent?.(); }} open={cloudDialogOpen} />
    </main>
  );
}
