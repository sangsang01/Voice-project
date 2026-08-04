export interface GoogleLanguageConfig {
  languageCode: string;
  alternativeLanguageCodes: string[];
}

export function toGoogleLanguageConfig(candidateLanguages: readonly string[]): GoogleLanguageConfig {
  const unique = [...new Set(candidateLanguages)];
  if (unique.length !== candidateLanguages.length || unique.length < 1 || unique.length > 4) {
    throw new RangeError("Google streaming requires 1-4 unique candidate languages");
  }
  const [languageCode, ...alternativeLanguageCodes] = unique as [string, ...string[]];
  return { languageCode, alternativeLanguageCodes };
}
