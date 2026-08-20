import { useEffect, useReducer, useRef, useState } from "react";
import { LocalWhisperEngine } from "@voice/local-whisper-engine";
import { RemoteWhisperEngine } from "@voice/remote-whisper-engine";
import type { TranscriptionEngine } from "@voice/transcription-contracts";
import { EarthGlobe } from "../../components/EarthGlobe";
import { SessionController, type EngineFactory, type MicrophoneFactory } from "./sessionController";
import { createSessionState, sessionReducer } from "./sessionReducer";

const LANGUAGES = [["en-US", "English (US)"], ["vi-VN", "Vietnamese"], ["es-ES", "Spanish"], ["zh-CN", "Chinese"]] as const;
type EngineMode = "remote" | "local";

interface TranscriptionAdapterProps {
  initialLanguages?: readonly string[];
  engineFactory?: EngineFactory;
  microphoneFactory?: MicrophoneFactory;
}

interface WindowEngineSeam {
  __transcriptionEngineFactory?: EngineFactory;
}

function createEngine(mode: EngineMode, onProgress: (value: number) => void): TranscriptionEngine {
  if (mode === "local") return new LocalWhisperEngine({ onProgress });
  const endpoint = import.meta.env.VITE_TRANSCRIPTION_WS_URL;
  if (!endpoint) throw new Error("VITE_TRANSCRIPTION_WS_URL is required for online real-time mode");
  const tokenUrl = import.meta.env.VITE_TRANSCRIPTION_TOKEN_URL ?? "/api/transcription-token";
  return new RemoteWhisperEngine({
    endpoint,
    tokenProvider: async () => {
      const response = await fetch(tokenUrl, { credentials: "include" });
      if (!response.ok) throw new Error("Unable to authorize transcription");
      const value = await response.json() as { token?: unknown };
      if (typeof value.token !== "string" || value.token.length === 0) {
        throw new Error("Transcription authorization returned no token");
      }
      return value.token;
    },
  });
}

function defaultEngineMode(): EngineMode {
  return import.meta.env.VITE_TRANSCRIPTION_WS_URL ? "remote" : "local";
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
  const [switchingMode, setSwitchingMode] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number>();
  const [engineMode, setEngineMode] = useState<EngineMode>(defaultEngineMode);
  const [now, setNow] = useState(() => new Date());
  const runGeneration = useRef(0);
  const engineModeRef = useRef<EngineMode>(engineMode);

  // Constructed lazily on first render rather than from props/state:
  // SessionController's constructor is pure (only assigns fields, no
  // subscriptions or timers), so it's safe for React to invoke this
  // initializer more than once (e.g. Strict Mode) and keep only one result.
  // Disposal still needs an effect, since that's a side effect on unmount.
  // The factory closes over engineModeRef but is not invoked during construction.
  // eslint-disable-next-line react-hooks/refs -- factory stored, not called during render
  const [controller] = useState<SessionController>(() => new SessionController({
    dispatch,
    engineFactory: engineFactory ?? ((options) => {
      const fromWindow = (window as Window & WindowEngineSeam).__transcriptionEngineFactory;
      if (fromWindow) return fromWindow(options);
      return createEngine(engineModeRef.current, options?.onProgress ?? (() => undefined));
    }),
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

  const remoteAvailable = Boolean(import.meta.env.VITE_TRANSCRIPTION_WS_URL);
  const error = selectionError ?? localError ?? state.fatalError?.message;
  const preparing = !error && starting;
  const listening = !error && (state.engineState === "listening" || state.engineState === "draining");
  const controlsLocked = preparing || listening || switchingMode;
  const hasValidSelection = candidateLanguages.length >= 1 && candidateLanguages.length <= 4 && new Set(candidateLanguages).size === candidateLanguages.length;
  const toggleLanguage = (tag: string) => {
    setSelectionError(undefined);
    setCandidateLanguages((selected) => selected.includes(tag) ? selected.filter((language) => language !== tag) : [...selected, tag]);
  };
  const run = async (operation: () => Promise<unknown>) => {
    if (!hasValidSelection) { setSelectionError("Select between 1 and 4 unique languages"); return; }
    const generation = ++runGeneration.current;
    setSelectionError(undefined); setLocalError(undefined); setBackpressureWarning(undefined); setLoadProgress(undefined); setStarting(true);
    try { await operation(); } catch { /* controller emits the normalized local error */ } finally { if (runGeneration.current === generation) setStarting(false); }
  };
  const changeMode = async (mode: EngineMode) => {
    if (mode === engineModeRef.current || switchingMode) return;
    setSwitchingMode(true);
    setLocalError(undefined);
    setBackpressureWarning(undefined);
    setLoadProgress(undefined);
    engineModeRef.current = mode;
    setEngineMode(mode);
    try {
      await controller.resetEngine();
    } catch {
      /* controller emits the normalized local error */
    } finally {
      setSwitchingMode(false);
    }
  };

  return (
    <main className="app-shell">
      <section className="voice-console" aria-label="Earth Assistant voice console">
        <aside className="console-controls">
          <header className="console-title"><p>Voice console</p><h1>Earth Assistant</h1></header>
          <div aria-label="Candidate languages">{LANGUAGES.map(([tag, label]) => <button aria-pressed={candidateLanguages.includes(tag)} className="control-button" key={tag} onClick={() => toggleLanguage(tag)} type="button">{label}</button>)}</div>
          <div aria-label="Transcription mode">
            <button
              aria-pressed={engineMode === "remote"}
              className="control-button"
              disabled={controlsLocked || !remoteAvailable}
              onClick={() => void changeMode("remote")}
              title={remoteAvailable ? undefined : "Configure VITE_TRANSCRIPTION_WS_URL to enable online real-time mode"}
              type="button"
            >
              Online real-time
            </button>
            <button aria-pressed={engineMode === "local"} className="control-button" disabled={controlsLocked} onClick={() => void changeMode("local")} type="button">Offline local</button>
          </div>
          <button className="control-button" disabled={controlsLocked} onClick={() => void run(() => controller.start(candidateLanguages))} type="button">Start</button>
          <button className="control-button" disabled={!preparing && !listening} onClick={() => { runGeneration.current += 1; setStarting(false); setLoadProgress(undefined); void controller.stop(); }} type="button">Stop</button>
          <button className="control-button" disabled={switchingMode} onClick={() => void run(() => controller.clearAndRestart(candidateLanguages))} type="button">Clear &amp; Restart</button>
          <div className="console-meta"><p aria-atomic="true" aria-live="polite" className="status" role="status"><span className={`status-dot${listening ? " status-dot--listening" : ""}`} aria-hidden="true" />{preparing ? "Preparing" : listening ? "Listening" : "Standby"}</p><p className="engine-mode">{engineMode === "remote" ? "Online real-time" : "Offline local"}</p><p className="clock">Local {formatClock(now, false)} · UTC {formatClock(now, true)}</p></div>
        </aside>
        <section className="console-output" aria-label="Voice transcript">
          <EarthGlobe listening={listening} />
          <div className="transcript" aria-live="off">
            {state.segments.length === 0 ? <span>Press Start and speak — your words appear here.</span> : state.segments.map((segment) => (
              <p
                className={segment.isFinal ? "transcript-segment" : "transcript-segment transcript-segment--provisional"}
                data-final={segment.isFinal ? "true" : "false"}
                key={segment.id}
              >
                <span>{segment.text}</span> <small>{segment.language.tag}</small>
                {!segment.isFinal && <span className="transcript-updating"> Updating</span>}
              </p>
            ))}
            {state.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}
            {backpressureWarning && <p>{backpressureWarning}</p>}
          </div>
          <div aria-live="polite" className="visually-hidden">
            {state.segments.filter((segment) => segment.isFinal).map((segment) => (
              <p key={segment.id}>{segment.text}</p>
            ))}
          </div>
          {starting && <p aria-atomic="true" aria-live="polite">Preparing local model{loadProgress === undefined ? "…" : ` ${Math.round(loadProgress * 100)}%`}{loadProgress !== undefined && <progress aria-label="Local model preparation" max={1} value={loadProgress} />}</p>}
          {error && <p role="alert">{error}</p>}
        </section>
      </section>
    </main>
  );
}
