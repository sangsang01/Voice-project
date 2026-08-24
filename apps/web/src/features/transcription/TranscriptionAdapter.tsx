import { useEffect, useReducer, useRef, useState } from "react";
import { LocalWhisperEngine } from "@voice/local-whisper-engine";
import { RemoteWhisperEngine } from "@voice/remote-whisper-engine";
import type { TranscriptionEngine } from "@voice/transcription-contracts";
import { EarthGlobe } from "../../components/EarthGlobe";
import { SessionController, type EngineFactory, type MicrophoneFactory } from "./sessionController";
import { createSessionState, sessionReducer } from "./sessionReducer";

const LANGUAGES = [["en-US", "English (US)"], ["vi-VN", "Vietnamese"], ["es-ES", "Spanish"], ["zh-CN", "Chinese"]] as const;
interface TranscriptionAdapterProps { initialLanguages?: readonly string[]; engineFactory?: EngineFactory; microphoneFactory?: MicrophoneFactory; }

type EngineMode = "live" | "offline";

const MODE_LABELS: Record<EngineMode, string> = {
  live: "Live (this PC)",
  offline: "Offline local",
};

function createEngine(mode: EngineMode, onProgress: (value: number) => void): TranscriptionEngine {
  if (mode === "offline") return new LocalWhisperEngine({ onProgress });
  const endpoint = import.meta.env.VITE_TRANSCRIPTION_WS_URL ?? "ws://127.0.0.1:8787";
  return new RemoteWhisperEngine({ endpoint });
}

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
  const [engineMode, setEngineMode] = useState<EngineMode>("live");
  const [resettingEngine, setResettingEngine] = useState(false);
  const runGeneration = useRef(0);
  const modeRef = useRef<EngineMode>("live");

  // Constructed lazily on first render rather than from props/state:
  // SessionController's constructor is pure (only assigns fields, no
  // subscriptions or timers), so it's safe for React to invoke this
  // initializer more than once (e.g. Strict Mode) and keep only one result.
  // Disposal still needs an effect, since that's a side effect on unmount.
  // eslint-disable-next-line react-hooks/refs -- factory is stored, not invoked; modeRef is read on Start
  const [controller] = useState<SessionController>(() => new SessionController({
    dispatch,
    engineFactory: engineFactory ?? ((options) => createEngine(modeRef.current, options?.onProgress ?? (() => undefined))),
    microphoneFactory,
    onProgress: setLoadProgress,
    onLocalError: setLocalError,
    onBackpressureWarning: setBackpressureWarning,
  }));
  useEffect(() => {
    return () => { runGeneration.current += 1; void controller.dispose(); };
  }, [controller]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  const error = selectionError ?? localError ?? state.fatalError?.message;
  const preparing = !error && starting;
  const listening = !error && (state.engineState === "listening" || state.engineState === "draining");
  const controlsBusy = preparing || listening || resettingEngine;
  const hasValidSelection = candidateLanguages.length >= 1 && candidateLanguages.length <= 4 && new Set(candidateLanguages).size === candidateLanguages.length;
  const toggleLanguage = (tag: string) => {
    setSelectionError(undefined);
    setCandidateLanguages((selected) => selected.includes(tag) ? selected.filter((language) => language !== tag) : [...selected, tag]);
  };
  const selectMode = (mode: EngineMode) => {
    if (mode === modeRef.current) return;
    modeRef.current = mode;
    setEngineMode(mode);
    setResettingEngine(true);
    void controller.resetEngine().finally(() => setResettingEngine(false));
  };
  const run = async (operation: () => Promise<unknown>) => {
    if (!hasValidSelection) { setSelectionError("Select between 1 and 4 unique languages"); return; }
    const generation = ++runGeneration.current;
    setSelectionError(undefined); setLocalError(undefined); setBackpressureWarning(undefined); setLoadProgress(undefined); setStarting(true);
    try { await operation(); } catch { /* controller emits the normalized local error */ } finally { if (runGeneration.current === generation) setStarting(false); }
  };
  const finalizedText = state.segments.filter((segment) => segment.isFinal).map((segment) => segment.text).join(" ");

  return (
    <main className="app-shell">
      <section className="voice-console" aria-label="Earth Assistant voice console">
        <aside className="console-controls">
          <header className="console-title"><p>Voice console</p><h1>Earth Assistant</h1></header>
          <div aria-label="Candidate languages">{LANGUAGES.map(([tag, label]) => <button aria-pressed={candidateLanguages.includes(tag)} className="control-button" key={tag} onClick={() => toggleLanguage(tag)} type="button">{label}</button>)}</div>
          <div aria-label="Transcription mode">
            {(["live", "offline"] as const).map((mode) => (
              <button
                aria-pressed={engineMode === mode}
                className="control-button"
                disabled={controlsBusy}
                key={mode}
                onClick={() => selectMode(mode)}
                type="button"
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
          <button className="control-button" disabled={controlsBusy} onClick={() => void run(() => controller.start(candidateLanguages))} type="button">Start</button>
          <button className="control-button" disabled={!preparing && !listening} onClick={() => { runGeneration.current += 1; setStarting(false); setLoadProgress(undefined); void controller.stop(); }} type="button">Stop</button>
          <button className="control-button" onClick={() => void run(() => controller.clearAndRestart(candidateLanguages))} type="button">Clear &amp; Restart</button>
          <div className="console-meta"><p aria-atomic="true" aria-live="polite" className="status" role="status"><span className={`status-dot${listening ? " status-dot--listening" : ""}`} aria-hidden="true" />{preparing ? "Preparing" : listening ? "Listening" : "Standby"}</p><p className="engine-mode">{MODE_LABELS[engineMode]}</p><p className="clock">Local {formatClock(now, false)} · UTC {formatClock(now, true)}</p></div>
        </aside>
        <section className="console-output" aria-label="Voice transcript">
          <EarthGlobe listening={listening} />
          <div className="transcript" aria-live="off">
            {state.segments.length === 0 ? <span>Press Start and speak — your words appear here.</span> : state.segments.map((segment) => (
              <p
                key={segment.id}
                className={segment.isFinal ? "transcript-segment" : "transcript-segment transcript-segment--provisional"}
                data-final={segment.isFinal ? "true" : "false"}
              >
                <span>{segment.text}</span>
                {!segment.isFinal && <span className="transcript-updating"> Updating</span>}
                <small>{segment.language.tag}</small>
              </p>
            ))}
            {state.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}
            {backpressureWarning && <p>{backpressureWarning}</p>}
          </div>
          <div className="visually-hidden" aria-live="polite">{finalizedText}</div>
          {starting && <p aria-atomic="true" aria-live="polite">Preparing local model{loadProgress === undefined ? "…" : ` ${Math.round(loadProgress * 100)}%`}{loadProgress !== undefined && <progress aria-label="Local model preparation" max={1} value={loadProgress} />}</p>}
          {error && <p role="alert">{error}</p>}
        </section>
      </section>
    </main>
  );
}
