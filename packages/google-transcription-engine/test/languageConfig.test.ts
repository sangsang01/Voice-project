import { describe, expect, it } from "vitest";
import { toGoogleLanguageConfig } from "../src/languageConfig";

describe("toGoogleLanguageConfig", () => {
  it("maps the first language to primary and the remaining three to alternatives", () => {
    expect(toGoogleLanguageConfig(["vi-VN", "en-US", "es-ES", "zh-CN"])).toEqual({
      languageCode: "vi-VN",
      alternativeLanguageCodes: ["en-US", "es-ES", "zh-CN"],
    });
  });

  const invalidCandidateSets: Array<[string[]]> = [
    [[]],
    [["en-US", "en-US"]],
    [["en-US", "vi-VN", "es-ES", "zh-CN", "fr-FR"]],
  ];

  it.each(invalidCandidateSets)("rejects invalid candidate set %j", (languages) =>
    expect(() => toGoogleLanguageConfig(languages)).toThrow(),
  );
});
