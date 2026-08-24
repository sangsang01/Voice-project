/**
 * whisper reports one bare ISO-639-1 code per utterance (e.g. "vi"), while the
 * app speaks in BCP-47 candidate tags (e.g. "vi-VN"). Anything whisper hears
 * that the user did not select is reported as `und` rather than being forced
 * onto the nearest candidate -- a wrong label is worse than no label.
 */
export declare function pinnedWhisperLanguage(candidates: readonly string[]): string | undefined;
/** When auto-detect is outside the user's selection, try these languages next. */
export declare function fallbackWhisperLanguages(detected: string, candidates: readonly string[]): string[];
export declare function mapDetectedLanguage(detected: string, probability: number, candidates: readonly string[]): {
    tag: string;
    confidence?: number;
};
