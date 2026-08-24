/**
 * whisper reports one bare ISO-639-1 code per utterance (e.g. "vi"), while the
 * app speaks in BCP-47 candidate tags (e.g. "vi-VN"). Anything whisper hears
 * that the user did not select is reported as `und` rather than being forced
 * onto the nearest candidate -- a wrong label is worse than no label.
 */
export function pinnedWhisperLanguage(candidates) {
    if (candidates.length !== 1)
        return undefined;
    const base = candidates[0]?.split("-", 1)[0]?.trim().toLowerCase();
    return base && base !== "und" ? base : undefined;
}
const CHINESE_CODES = new Set(["zh", "yue", "zh-cn", "zh-tw"]);
function candidateBases(candidates) {
    const bases = [];
    for (const tag of candidates) {
        const base = tag.split("-", 1)[0]?.trim().toLowerCase();
        if (!base || base === "und" || bases.includes(base))
            continue;
        bases.push(base);
    }
    return bases;
}
/** When auto-detect is outside the user's selection, try these languages next. */
export function fallbackWhisperLanguages(detected, candidates) {
    if (mapDetectedLanguage(detected, 1, candidates).tag !== "und")
        return [];
    const detectedBase = detected.trim().toLowerCase();
    const remaining = candidateBases(candidates).filter((base) => base !== detectedBase);
    if (CHINESE_CODES.has(detectedBase) && remaining.includes("vi")) {
        return ["vi", ...remaining.filter((base) => base !== "vi")];
    }
    return remaining;
}
export function mapDetectedLanguage(detected, probability, candidates) {
    const base = detected.trim().toLowerCase();
    if (!base || base === "und" || probability <= 0)
        return { tag: "und" };
    const match = candidates.find((tag) => tag.split("-", 1)[0]?.toLowerCase() === base);
    return match ? { tag: match, confidence: probability } : { tag: "und" };
}
