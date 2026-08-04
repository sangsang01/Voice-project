export interface CandidateLanguageScore {
    iso6393: string;
    confidence: number;
}
/** Scores text only against the ISO-639-3 codes corresponding to selected candidates. */
export interface CandidateLanguageScorer {
    score(text: string, candidateIso6393: readonly string[]): CandidateLanguageScore | undefined;
}
export interface LanguageLabelerOptions {
    candidateLanguages: readonly string[];
    confidenceThreshold?: number;
    scorer?: CandidateLanguageScorer;
}
export interface SegmentLanguageInput {
    /** Identifies the segment being revised; labels never make word-level claims. */
    segmentId: string;
    text: string;
    isFinal: boolean;
}
export interface SegmentLanguageLabel {
    language: {
        tag: string | "und";
        confidence?: number;
    };
    warning?: {
        code: "LANGUAGE_UNCERTAIN";
        message: string;
    };
}
/**
 * Labels complete transcript segments from the user-selected candidates only.
 * It deliberately returns `und` whenever the text cannot support a conservative
 * segment-level label; it does not infer languages for individual words.
 */
export declare function createLanguageLabeler(options: LanguageLabelerOptions): {
    label(input: SegmentLanguageInput): SegmentLanguageLabel;
};
