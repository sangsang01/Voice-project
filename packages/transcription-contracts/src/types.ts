export type CandidateLanguages = readonly [string, ...string[]];

export interface SessionRequest {
  sessionId: string;
  candidateLanguages: CandidateLanguages;
  mode: "transcribe";
  audio: {
    encoding: "pcm_s16le";
    sampleRateHz: 16000;
    channels: 1;
    frameDurationMs: 20;
  };
}

export interface PcmFrame {
  sequence: number;
  startMs: number;
  samples: Int16Array;
}

export interface TranscriptSegment {
  id: string;
  ordinal: number;
  revision: number;
  startMs: number;
  endMs: number;
  text: string;
  language: { tag: string | "und"; confidence?: number };
  isFinal: boolean;
}
