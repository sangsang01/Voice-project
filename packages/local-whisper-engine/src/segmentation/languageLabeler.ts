import { francAll } from "franc-min";

const ISO_639_3_BY_BASE_LANGUAGE: Readonly<Record<string, string>> = {
  ar: "arb",
  de: "deu",
  en: "eng",
  es: "spa",
  fr: "fra",
  hi: "hin",
  id: "ind",
  it: "ita",
  ja: "jpn",
  ko: "kor",
  pt: "por",
  ru: "rus",
  th: "tha",
  tr: "tur",
  uk: "ukr",
  vi: "vie",
  zh: "cmn",
};

const HAN_SCRIPT = /\p{Script=Han}/u;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.22;

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

interface LabelState {
  establishedTag?: string;
  pendingTag?: string;
  pendingCount: number;
}

const francMinScorer: CandidateLanguageScorer = {
  score(text, candidateIso6393) {
    const [winner, runnerUp] = francAll(text, { only: [...candidateIso6393], minLength: 0 });
    if (!winner || winner[0] === "und" || !runnerUp) return undefined;

    // franc-min normalizes every winning score to one. The separation from the
    // runner-up is the useful candidate-relative signal, not that top score.
    return { iso6393: winner[0], confidence: winner[1] - runnerUp[1] };
  },
};

/**
 * Labels complete transcript segments from the user-selected candidates only.
 * It deliberately returns `und` whenever the text cannot support a conservative
 * segment-level label; it does not infer languages for individual words.
 */
export function createLanguageLabeler(options: LanguageLabelerOptions) {
  const candidateLanguages = [...options.candidateLanguages];
  const candidateByIso6393 = new Map<string, string>();

  for (const tag of candidateLanguages) {
    const iso6393 = ISO_639_3_BY_BASE_LANGUAGE[baseLanguage(tag)];
    if (iso6393 && !candidateByIso6393.has(iso6393)) candidateByIso6393.set(iso6393, tag);
  }

  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError("confidenceThreshold must be between 0 and 1");
  }

  const scorer = options.scorer ?? francMinScorer;
  const states = new Map<string, LabelState>();
  const candidateIso6393 = [...candidateByIso6393.keys()];

  return {
    label(input: SegmentLanguageInput): SegmentLanguageLabel {
      const state = states.get(input.segmentId) ?? { pendingCount: 0 };
      const winner = selectWinner(input.text, candidateLanguages, candidateByIso6393, candidateIso6393, scorer);

      if (!winner || !Number.isFinite(winner.confidence) || winner.confidence <= threshold) {
        states.set(input.segmentId, state);
        return uncertain();
      }

      if (!state.establishedTag) {
        state.establishedTag = winner.tag;
        state.pendingTag = undefined;
        state.pendingCount = 0;
        states.set(input.segmentId, state);
        return certain(winner.tag, winner.confidence);
      }

      if (state.establishedTag === winner.tag) {
        state.pendingTag = undefined;
        state.pendingCount = 0;
        states.set(input.segmentId, state);
        return certain(winner.tag, winner.confidence);
      }

      state.pendingCount = state.pendingTag === winner.tag ? state.pendingCount + 1 : 1;
      state.pendingTag = winner.tag;

      if (state.pendingCount >= 2) {
        state.establishedTag = winner.tag;
        state.pendingTag = undefined;
        state.pendingCount = 0;
        states.set(input.segmentId, state);
        return certain(winner.tag, winner.confidence);
      }

      states.set(input.segmentId, state);
      return uncertain();
    },
  };
}

function selectWinner(
  text: string,
  candidateLanguages: readonly string[],
  candidateByIso6393: ReadonlyMap<string, string>,
  candidateIso6393: readonly string[],
  scorer: CandidateLanguageScorer,
): (CandidateLanguageScore & { tag: string }) | undefined {
  if (HAN_SCRIPT.test(text)) {
    const chinese = candidateLanguages.find((tag) => baseLanguage(tag) === "zh");
    return chinese ? { tag: chinese, iso6393: "cmn", confidence: 1 } : undefined;
  }

  const score = scorer.score(text, candidateIso6393);
  const tag = score && candidateByIso6393.get(score.iso6393);
  return score && tag ? { ...score, tag } : undefined;
}

function baseLanguage(tag: string): string {
  return tag.split("-", 1)[0]?.toLowerCase() ?? "";
}

function certain(tag: string, confidence: number): SegmentLanguageLabel {
  return { language: { tag, confidence } };
}

function uncertain(): SegmentLanguageLabel {
  return {
    language: { tag: "und" },
    warning: {
      code: "LANGUAGE_UNCERTAIN",
      message: "Language could not be determined with sufficient confidence.",
    },
  };
}
