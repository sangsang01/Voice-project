import type { ErrorCode } from "@voice/transcription-contracts";
import { FRAME_SAMPLES, type PcmFrame } from "./pcm";
import {
  PCM_WORKLET_PROCESSOR,
  pcmWorkletSource,
  type PcmWorkletMessage,
} from "./pcm-worklet";

export interface MediaStreamTrackLike {
  stop(): void;
}

export interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[];
}

export interface AudioNodeLike {
  connect(destination: unknown): unknown;
  disconnect(): void;
}

export interface AudioContextLike {
  audioWorklet?: { addModule(url: string): Promise<void> };
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
  destination?: unknown;
}

export interface AudioWorkletNodeLike extends AudioNodeLike {
  port: {
    onmessage: ((event: MessageEvent<PcmWorkletMessage>) => void) | null;
  };
}

export interface MicrophoneDependencies {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
  createAudioContext(): AudioContextLike;
  createWorkletNode(context: AudioContextLike, name: string): AudioWorkletNodeLike;
  createWorkletUrl(source: string): string;
  revokeWorkletUrl(url: string): void;
  isAudioWorkletSupported(context: AudioContextLike): boolean;
}

export interface MicrophoneCapture {
  stop(): Promise<void>;
}

export interface StartMicrophoneCaptureOptions {
  onFrame(frame: PcmFrame): void;
  signal?: AbortSignal;
  dependencies?: MicrophoneDependencies;
}

export class MicrophoneCaptureError extends Error {
  public readonly code: Extract<ErrorCode, "UNAVAILABLE" | "UNSUPPORTED">;

  public constructor(
    code: Extract<ErrorCode, "UNAVAILABLE" | "UNSUPPORTED"> = "UNAVAILABLE",
    message = "Microphone unavailable",
  ) {
    super(message);
    this.name = "MicrophoneCaptureError";
    this.code = code;
  }
}

export async function startMicrophoneCapture(
  options: StartMicrophoneCaptureOptions,
): Promise<MicrophoneCapture> {
  const dependencies = options.dependencies ?? createBrowserDependencies();
  let stream: MediaStreamLike | undefined;
  let context: AudioContextLike | undefined;
  let source: AudioNodeLike | undefined;
  let workletNode: AudioWorkletNodeLike | undefined;
  let workletUrl: string | undefined;
  let finalization: Promise<void> | undefined;
  let abortHandler: (() => void) | undefined;

  const stop = (): Promise<void> => {
    finalization ??= finalize();
    return finalization;
  };

  const finalize = async (): Promise<void> => {
    if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    if (workletNode) workletNode.port.onmessage = null;

    disconnect(workletNode);
    disconnect(source);

    if (workletUrl) {
      try {
        dependencies.revokeWorkletUrl(workletUrl);
      } catch {
        // URL revocation is best-effort and must not interrupt media cleanup.
      }
      workletUrl = undefined;
    }

    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // A stopped browser track can reject redundant cleanup.
        }
      }
      stream = undefined;
    }

    if (context) {
      const contextToClose = context;
      context = undefined;
      try {
        await contextToClose.close();
      } catch {
        // The context is already terminal; preserve the startup or stop result.
      }
    }
  };

  try {
    if (options.signal?.aborted) throw new MicrophoneCaptureError("UNAVAILABLE", "Microphone capture aborted");

    context = dependencies.createAudioContext();
    await context.resume();
    if (!dependencies.isAudioWorkletSupported(context) || !context.audioWorklet) {
      throw new MicrophoneCaptureError("UNSUPPORTED", "AudioWorklet is not supported");
    }

    stream = await dependencies.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    workletUrl = dependencies.createWorkletUrl(pcmWorkletSource);
    await context.audioWorklet.addModule(workletUrl);

    if (options.signal?.aborted) {
      await stop();
      throw new MicrophoneCaptureError("UNAVAILABLE", "Microphone capture aborted");
    }

    source = context.createMediaStreamSource(stream);
    workletNode = dependencies.createWorkletNode(context, PCM_WORKLET_PROCESSOR);
    workletNode.port.onmessage = (event) => {
      const frame = toPcmFrame(event.data);
      if (frame) options.onFrame(frame);
    };
    source.connect(workletNode);

    abortHandler = () => {
      void stop();
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    return { stop };
  } catch (error) {
    await stop();
    if (error instanceof MicrophoneCaptureError) throw error;
    throw new MicrophoneCaptureError("UNAVAILABLE", permissionMessage(error));
  }
}

function toPcmFrame(message: PcmWorkletMessage): PcmFrame | undefined {
  if (
    message?.type !== "pcm-frame" ||
    !Number.isSafeInteger(message.sequence) ||
    !Number.isFinite(message.startMs) ||
    !(message.samples instanceof ArrayBuffer)
  ) {
    return undefined;
  }

  const samples = new Int16Array(message.samples);
  return samples.length === FRAME_SAMPLES
    ? { sequence: message.sequence, startMs: message.startMs, samples }
    : undefined;
}

function disconnect(node: AudioNodeLike | undefined): void {
  try {
    node?.disconnect();
  } catch {
    // Disconnect can throw after browser-owned teardown; remaining resources still need cleanup.
  }
}

function permissionMessage(error: unknown): string {
  return error instanceof DOMException && error.name === "NotAllowedError"
    ? "Microphone permission was denied"
    : "Microphone unavailable";
}

function createBrowserDependencies(): MicrophoneDependencies {
  return {
    async getUserMedia(constraints) {
      const getUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia;
      if (!getUserMedia) throw new MicrophoneCaptureError();
      return getUserMedia.call(globalThis.navigator.mediaDevices, constraints);
    },
    createAudioContext() {
      const browserGlobal = globalThis as typeof globalThis & {
        webkitAudioContext?: new () => AudioContext;
      };
      const AudioContextConstructor = globalThis.AudioContext ?? browserGlobal.webkitAudioContext;
      if (!AudioContextConstructor) throw new MicrophoneCaptureError();
      return new AudioContextConstructor();
    },
    createWorkletNode(context, name) {
      // Zero outputs keeps process() running without a playback path that
      // Chromium-based security browsers (AVG) treat as echo and mute.
      return new AudioWorkletNode(context as AudioContext, name, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });
    },
    createWorkletUrl(_source) {
      const origin = globalThis.location?.origin;
      if (!origin) throw new MicrophoneCaptureError("UNSUPPORTED", "AudioWorklet is not supported");
      // Same-origin file: AVG Web Shield CSP commonly blocks blob: worklets.
      return new URL("/pcm-worklet.js", origin).href;
    },
    revokeWorkletUrl(url) {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    },
    isAudioWorkletSupported(context) {
      return Boolean(context.audioWorklet) && typeof AudioWorkletNode !== "undefined";
    },
  };
}
