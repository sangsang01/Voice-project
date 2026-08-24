import { describe, expect, it } from "vitest";

import { mapDetectedLanguage, pinnedWhisperLanguage, fallbackWhisperLanguages } from "../src/languageMap.js";

const CANDIDATES = ["vi-VN", "en-US", "es-ES", "zh-CN"];

describe("mapDetectedLanguage", () => {
  it("maps a bare ISO-639-1 code onto the matching candidate tag", () => {
    expect(mapDetectedLanguage("vi", 1, CANDIDATES)).toEqual({ tag: "vi-VN", confidence: 1 });
  });

  it("maps zh onto zh-CN", () => {
    expect(mapDetectedLanguage("zh", 1, CANDIDATES)).toEqual({ tag: "zh-CN", confidence: 1 });
  });

  it("returns und when whisper detects a language the user did not select", () => {
    expect(mapDetectedLanguage("de", 1, CANDIDATES)).toEqual({ tag: "und" });
  });

  it("returns und when whisper reported no language at all", () => {
    expect(mapDetectedLanguage("und", 0, CANDIDATES)).toEqual({ tag: "und" });
  });

  it("returns und when the detection carries no confidence", () => {
    expect(mapDetectedLanguage("en", 0, CANDIDATES)).toEqual({ tag: "und" });
  });

  it("is case-insensitive about the detected code", () => {
    expect(mapDetectedLanguage("EN", 1, CANDIDATES)).toEqual({ tag: "en-US", confidence: 1 });
  });

  it("honours a narrowed candidate list", () => {
    expect(mapDetectedLanguage("es", 1, ["en-US"])).toEqual({ tag: "und" });
  });
});

describe("pinnedWhisperLanguage", () => {
  it("pins a single candidate to a bare ISO-639-1 code", () => {
    expect(pinnedWhisperLanguage(["en-US"])).toBe("en");
    expect(pinnedWhisperLanguage(["vi-VN"])).toBe("vi");
  });

  it("leaves language unpinned when more than one candidate is selected", () => {
    expect(pinnedWhisperLanguage(["en-US", "vi-VN"])).toBeUndefined();
  });
});

describe("fallbackWhisperLanguages", () => {
  it("returns no fallbacks when the detected language is already a candidate", () => {
    expect(fallbackWhisperLanguages("en", ["en-US", "vi-VN"])).toEqual([]);
  });

  it("retries Vietnamese first when Chinese is detected but not selected", () => {
    expect(fallbackWhisperLanguages("zh", ["en-US", "vi-VN"])).toEqual(["vi", "en"]);
  });

  it("does not prefer Vietnamese when Chinese is one of the candidates", () => {
    expect(fallbackWhisperLanguages("de", ["en-US", "zh-CN"])).toEqual(["en", "zh"]);
  });
});
