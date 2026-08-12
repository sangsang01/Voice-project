import { describe, expect, it } from "vitest";

import { mapDetectedLanguage } from "../src/languageMap.js";

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
