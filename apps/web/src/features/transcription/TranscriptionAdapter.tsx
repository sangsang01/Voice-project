import { useEffect, useReducer, useRef, useState } from "react";
import { EarthGlobe } from "../../components/EarthGlobe";
import { CloudConsentDialog } from "./CloudConsentDialog";
import { createTranscriptionEngine } from "./engineFactory";
import { SessionController, type EngineFactory, type MicrophoneFactory } from "./sessionController";
import { createSessionState, sessionReducer } from "./sessionReducer";

const LANGUAGES = [["en-US", "English (US)"], ["vi-VN", "Vietnamese"], ["es-ES", "Spanish"], ["zh-CN", "Chinese"]] as const;
const DEFAULT_WEBSOCKET_URL = (import.meta.env.VITE_TRANSCRIPTION_WS_URL as string | undefined) ?? "ws://localhost:8080";
type EngineKind = "local" | "cloud";
interface TranscriptionAdapterProps { initialLanguages?: readonly string[]; engineFactory?: EngineFactory; microphoneFactory?: MicrophoneFactory; websocketUrl?: string; onCloudConsent?(): void; }

function formatClock(date: Date, utc: boolean) {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${part(utc ? date.getUTCHours() : date.getHours())}:${part(utc ? date.getUTCMinutes() : date.getMinutes())}:${part(utc ? date.getUTCSeconds() : date.getSeconds())}`;
}

export function TranscriptionAdapter({ initialLanguages = [], engineFactory, microphoneFactory, websocketUrl = DEFAULT_WEBSOCKET_URL, onCloudConsent }: TranscriptionAdapterProps) {
  const [state, dispatch] = useReducer(sessionReducer, "transcription-idle", createSessionState);
  const [candidateLanguages, setCandidateLanguages] = useState<readonly string[]>(initialLanguages);
  const [selectionError, setSelectionError] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const [backpressureWarning, setBackpressureWarning] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false);
  const [engineKind, setEngineKind] = useState<EngineKind>("local");
  const [now, setNow] = useState(() => new Date());
  // Read by the default engine factory below so a fresh engine of the *current*
  // kind is created on every start(), without needing to recreate the controller.
  const engineKindRef = useRef<EngineKind>(engineKind);
  useEffect(() => {
    engineKindRef.current = engineKind;
  }, [engineKind]);

  // Constructed in an effect (not during render) so the ref above is safe to
  // close over -- SessionController itself has no serializable render output.
  const [controller, setController] = useState<SessionController | null>(null);
  useEffect(() => {
    const instance = new SessionController({
      dispatch,
      engineFactory: engineFactory ?? (() => createTranscriptionEngine({
        kind: engineKindRef.current,
        cloudConsent: engineKindRef.current === "cloud",
        websocketUrl,
      })),
      microphoneFactory,
      onLocalError: setLocalError,
      onBackpressureWarning: setBackpressureWarning,
    });
    setController(instance);
    return () => { void instance.dispose(); };
    // Constructed once per mount; engineFactory/microphoneFactory overrides and websocketUrl are test/config seams, not reactive inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setSelectionError(undefined); setLocalError(undefined); setBackpressureWarning(undefined); setStarting(true);
    try { await operation(); } catch { /* controller emits the normalized local error */ } finally { setStarting(false); }
  };

  return (
    <main className="app-shell">
      <section className="voice-console" aria-label="Earth Assistant voice console">
        <aside className="console-controls">
          <header className="console-title"><p>Voice console</p><h1>Earth Assistant</h1></header>
          <div aria-label="Candidate languages">{LANGUAGES.map(([tag, label]) => <button aria-pressed={candidateLanguages.includes(tag)} className="control-button" key={tag} onClick={() => toggleLanguage(tag)} type="button">{label}</button>)}</div>
          <button className="control-button" disabled={!controller || listening} onClick={() => controller && void run(() => controller.start(candidateLanguages))} type="button">Start</button>
          <button className="control-button" disabled={!controller || !listening} onClick={() => controller && void controller.stop()} type="button">Stop</button>
          <button className="control-button" disabled={!controller} onClick={() => controller && void run(() => controller.clearAndRestart(candidateLanguages))} type="button">Clear &amp; Restart</button>
          <button className="control-button" disabled={listening} onClick={() => engineKind === "cloud" ? setEngineKind("local") : setCloudDialogOpen(true)} type="button">{engineKind === "cloud" ? "Switch to local transcription" : "Use cloud transcription"}</button>
          <div className="console-meta"><p aria-atomic="true" aria-live="polite" className="status" role="status"><span className={`status-dot${listening ? " status-dot--listening" : ""}`} aria-hidden="true" />{listening ? "Listening" : "Standby"}</p><p className="engine-mode">{engineKind === "cloud" ? "Cloud transcription (consented)" : "Local transcription (on this device)"}</p><p className="clock">Local {formatClock(now, false)} · UTC {formatClock(now, true)}</p></div>
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
      <CloudConsentDialog onCancel={() => setCloudDialogOpen(false)} onConfirm={() => { setCloudDialogOpen(false); setEngineKind("cloud"); onCloudConsent?.(); }} open={cloudDialogOpen} />
    </main>
  );
}
