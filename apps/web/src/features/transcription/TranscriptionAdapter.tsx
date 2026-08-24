import { useEffect, useReducer, useRef, useState } from "react";
import { RemoteWhisperEngine } from "@voice/remote-whisper-engine";
import type { TranscriptionEngine } from "@voice/transcription-contracts";
import { EarthGlobe } from "../../components/EarthGlobe";
import { SessionController, type EngineFactory, type MicrophoneFactory } from "./sessionController";
import { createSessionState, sessionReducer } from "./sessionReducer";

const LANGUAGES = [["en-US", "English"], ["vi-VN", "Vietnamese"], ["es-ES", "Spanish"]] as const;
const LANGUAGE_TAGS = new Set(LANGUAGES.map(([tag]) => tag));
interface TranscriptionAdapterProps { initialLanguages?: readonly string[]; engineFactory?: EngineFactory; microphoneFactory?: MicrophoneFactory; }

function createEngine(): TranscriptionEngine {
  const endpoint = import.meta.env.VITE_TRANSCRIPTION_WS_URL ?? "ws://127.0.0.1:8787";
  return new RemoteWhisperEngine({ endpoint });
}

function initialLanguage(tags: readonly string[]): string {
  return tags.find((tag) => LANGUAGE_TAGS.has(tag)) ?? "en-US";
}

function createSessionController(options: {
  dispatch: ConstructorParameters<typeof SessionController>[0]["dispatch"];
  engineFactory?: EngineFactory;
  microphoneFactory?: MicrophoneFactory;
  setLoadProgress: (value: number | undefined) => void;
  setLocalError: (value: string | undefined) => void;
  setBackpressureWarning: (value: string | undefined) => void;
}): SessionController {
  return new SessionController({
    dispatch: options.dispatch,
    engineFactory: options.engineFactory ?? (() => createEngine()),
    microphoneFactory: options.microphoneFactory,
    onProgress: options.setLoadProgress,
    onLocalError: options.setLocalError,
    onBackpressureWarning: options.setBackpressureWarning,
  });
}

function formatClock(date: Date, utc: boolean) {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${part(utc ? date.getUTCHours() : date.getHours())}:${part(utc ? date.getUTCMinutes() : date.getMinutes())}:${part(utc ? date.getUTCSeconds() : date.getSeconds())}`;
}

export function TranscriptionAdapter({ initialLanguages = [], engineFactory, microphoneFactory }: TranscriptionAdapterProps) {
  const [state, dispatch] = useReducer(sessionReducer, "transcription-idle", createSessionState);
  const [language, setLanguage] = useState(() => initialLanguage(initialLanguages));
  const [localError, setLocalError] = useState<string>();
  const [backpressureWarning, setBackpressureWarning] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number>();
  const [now, setNow] = useState(() => new Date());
  const runGeneration = useRef(0);
  const controllerRef = useRef<SessionController | null>(null);

  // React Strict Mode re-runs an effect's cleanup and setup synchronously while
  // keeping refs/state. Defer disposal so that probe can cancel it; a real
  // unmount has no following setup and therefore disposes the controller.
  const disposeTimeoutRef = useRef<number | undefined>(undefined);
  if (controllerRef.current === null) {
    controllerRef.current = createSessionController({
      dispatch,
      engineFactory,
      microphoneFactory,
      setLoadProgress,
      setLocalError,
      setBackpressureWarning,
    });
  }
  const controller = controllerRef.current;
  useEffect(() => {
    if (disposeTimeoutRef.current !== undefined) {
      window.clearTimeout(disposeTimeoutRef.current);
      disposeTimeoutRef.current = undefined;
    }
    return () => {
      disposeTimeoutRef.current = window.setTimeout(() => {
        disposeTimeoutRef.current = undefined;
        runGeneration.current += 1;
        if (controllerRef.current === controller) controllerRef.current = null;
        void controller.dispose();
      }, 0);
    };
  }, [controller]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  const error = localError ?? state.fatalError?.message;
  const preparing = !error && starting;
  const listening = !error && (state.engineState === "listening" || state.engineState === "draining");
  const controlsBusy = preparing || listening;
  const selectedLanguages = [language];
  const run = async (operation: () => Promise<unknown>) => {
    const generation = ++runGeneration.current;
    setLocalError(undefined); setBackpressureWarning(undefined); setLoadProgress(undefined); setStarting(true);
    try { await operation(); } catch { /* controller emits the normalized local error */ } finally { if (runGeneration.current === generation) setStarting(false); }
  };
  const finalizedText = state.segments.filter((segment) => segment.isFinal).map((segment) => segment.text).join(" ");
  const languageLabel = (tag: string) => {
    if (tag === "und") return undefined;
    return LANGUAGES.find(([value]) => value === tag)?.[1] ?? tag;
  };

  return (
    <main className="app-shell">
      <section className="voice-console" aria-label="Earth Assistant voice console">
        <aside className="console-controls">
          <header className="console-title"><p>Voice console</p><h1>Earth Assistant</h1></header>
          <label className="language-field">
            <select
              aria-label="Language"
              className="control-button language-select"
              disabled={controlsBusy}
              onChange={(event) => setLanguage(event.target.value)}
              value={language}
            >
              {LANGUAGES.map(([tag, label]) => <option key={tag} value={tag}>{label}</option>)}
            </select>
          </label>
          <button className="control-button" disabled={controlsBusy} onClick={() => void run(() => controller.start(selectedLanguages))} type="button">Start</button>
          <button className="control-button" disabled={!preparing && !listening} onClick={() => { runGeneration.current += 1; setStarting(false); setLoadProgress(undefined); void controller.stop(); }} type="button">Stop</button>
          <button className="control-button" onClick={() => void run(() => controller.clearAndRestart(selectedLanguages))} type="button">Clear &amp; Restart</button>
          <div className="console-meta"><p aria-atomic="true" aria-live="polite" className="status" role="status"><span className={`status-dot${listening ? " status-dot--listening" : ""}`} aria-hidden="true" />{preparing ? "Preparing" : listening ? "Listening" : "Standby"}</p><p className="engine-mode">Live (this PC)</p><p className="clock">Local {formatClock(now, false)} · UTC {formatClock(now, true)}</p></div>
        </aside>
        <section className="console-output" aria-label="Voice transcript">
          <EarthGlobe listening={listening} />
          <div className="transcript" aria-live="off">
            {state.segments.length === 0 ? (
              listening ? (
                <span className="transcript-waiting">
                  <span className="transcript-waiting-dots" aria-hidden="true"><i /><i /><i /></span>
                  Hearing you… captions will appear here.
                </span>
              ) : (
                <span className="transcript-placeholder">Press Start and speak — your words appear here.</span>
              )
            ) : state.segments.map((segment) => {
              const spokenLanguage = languageLabel(segment.language.tag);
              return (
              <p
                key={segment.id}
                className={segment.isFinal ? "transcript-segment" : "transcript-segment transcript-segment--provisional"}
                data-final={segment.isFinal ? "true" : "false"}
              >
                <span>{segment.text}</span>
                {spokenLanguage && <small className="transcript-language">{spokenLanguage}</small>}
              </p>
              );
            })}
            {state.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}>{warning.message}</p>)}
            {backpressureWarning && <p>{backpressureWarning}</p>}
            {error && <p role="alert">{error}</p>}
          </div>
          <div className="visually-hidden" aria-live="polite">{finalizedText}</div>
          {starting && <p aria-atomic="true" aria-live="polite">Preparing local model{loadProgress === undefined ? "…" : ` ${Math.round(loadProgress * 100)}%`}{loadProgress !== undefined && <progress aria-label="Local model preparation" max={1} value={loadProgress} />}</p>}
        </section>
      </section>
    </main>
  );
}
