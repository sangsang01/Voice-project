/**
 * Server-only entrypoint. This is the sole module in the package that
 * (transitively, via googleClientFactory) imports @google-cloud/speech and
 * Application Default Credentials. Never import this from browser code.
 */
export { GoogleStream } from "./GoogleStream";
export type { GoogleAudioFrame, GoogleStreamOptions } from "./GoogleStream";
export { createProductionSpeechClientFactory } from "./googleClientFactory";
export type {
  GoogleDuplex,
  GoogleStreamingRecognitionConfig,
  GoogleStreamingRequestChunk,
  SpeechClientFactory,
} from "./googleClientFactory";
export { toGoogleLanguageConfig } from "./languageConfig";
export type { GoogleLanguageConfig } from "./languageConfig";
export { normalizeGoogleError, normalizeGoogleResult } from "./normalizeResult";
export type { NormalizeErrorContext, NormalizeResultContext } from "./normalizeResult";
export type {
  GoogleDuration,
  GoogleProviderError,
  GoogleRecognitionAlternative,
  GoogleStreamingRecognitionResult,
  GoogleStreamingRecognizeResponse,
} from "./providerTypes";
