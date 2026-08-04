import { describe, expect, it } from "vitest";

import { createLanguageLabeler, type CandidateLanguageScorer } from "../src/segmentation/languageLabeler.js";

const candidates = ["vi-VN", "en-US", "es-ES", "zh-CN"] as const;

const portfolioScores: CandidateLanguageScorer = {
  score(text, candidateIso6393) {
    expect(candidateIso6393).toEqual(["vie", "eng", "spa", "cmn"]);
    const scores = new Map([
      ["Xin chào", { iso6393: "vie", confidence: 0.98 }],
      ["My name is Sang", { iso6393: "eng", confidence: 0.97 }],
      ["Soy de Vietnam", { iso6393: "spa", confidence: 0.96 }],
      ["unsupported", { iso6393: "deu", confidence: 0.99 }],
      ["unclear", { iso6393: "eng", confidence: 0.2 }],
      ["hello", { iso6393: "eng", confidence: 0.99 }],
      ["hola", { iso6393: "spa", confidence: 0.99 }],
    ]);

    const result = scores.get(text);
    if (!result) throw new Error(`Unexpected text: ${text}`);
    return result;
  },
};

describe("candidate-constrained language labeler", () => {
  it.each([
    ["Xin chào", "vi-VN"],
    ["My name is Sang", "en-US"],
    ["Soy de Vietnam", "es-ES"],
    ["祝你有美好的一天", "zh-CN"],
  ] as const)("labels the stable portfolio segment %s as %s", (text, expectedTag) => {
    const labeler = createLanguageLabeler({ candidateLanguages: candidates, scorer: portfolioScores });

    const result = labeler.label({ segmentId: text, text, isFinal: true });

    expect(result.language).toMatchObject({ tag: expectedTag });
    expect(candidates).toContain(result.language.tag);
    expect(result.warning).toBeUndefined();
  });

  it("does not label an unsupported scorer winner", () => {
    const labeler = createLanguageLabeler({ candidateLanguages: candidates, scorer: portfolioScores });

    const result = labeler.label({ segmentId: "unsupported", text: "unsupported", isFinal: true });

    expect(result.language.tag).toBe("und");
    expect(result.warning?.code).toBe("LANGUAGE_UNCERTAIN");
  });

  it("does not label a low-confidence scorer result", () => {
    const labeler = createLanguageLabeler({ candidateLanguages: candidates, scorer: portfolioScores });

    const result = labeler.label({ segmentId: "unclear", text: "unclear", isFinal: true });

    expect(result.language.tag).toBe("und");
    expect(result.warning?.code).toBe("LANGUAGE_UNCERTAIN");
  });

  it("maps Arabic BCP-47 candidates to franc-min's arb code", () => {
    const scorer: CandidateLanguageScorer = {
      score(_text, candidateIso6393) {
        expect(candidateIso6393).toEqual(["arb"]);
        return { iso6393: "arb", confidence: 0.99 };
      },
    };
    const labeler = createLanguageLabeler({ candidateLanguages: ["ar-EG"], scorer });

    const result = labeler.label({
      segmentId: "arabic",
      text: "\u0645\u0631\u062d\u0628\u0627 \u0643\u064a\u0641 \u062d\u0627\u0644\u0643",
      isFinal: true,
    });

    expect(result.language.tag).toBe("ar-EG");
  });

  it("returns und for weak, ambiguous Latin text from the default scorer", () => {
    const labeler = createLanguageLabeler({ candidateLanguages: candidates });

    const result = labeler.label({ segmentId: "ambiguous", text: "the de", isFinal: true });

    expect(result.language.tag).toBe("und");
    expect(result.warning?.code).toBe("LANGUAGE_UNCERTAIN");
  });

  it("requires a second confident contrary result before changing an established label", () => {
    const labeler = createLanguageLabeler({ candidateLanguages: candidates, scorer: portfolioScores });

    expect(labeler.label({ segmentId: "same-segment", text: "hello", isFinal: false }).language.tag).toBe("en-US");

    const contrary = labeler.label({ segmentId: "same-segment", text: "hola", isFinal: false });

    expect(contrary.language.tag).toBe("und");
    expect(contrary.warning?.code).toBe("LANGUAGE_UNCERTAIN");

    const confirmed = labeler.label({ segmentId: "same-segment", text: "hola", isFinal: false });

    expect(confirmed.language.tag).toBe("es-ES");
  });
});
