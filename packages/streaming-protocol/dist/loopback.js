const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
export function assertLoopbackWebSocketUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new TypeError("transcription endpoint must be a valid URL");
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new TypeError("transcription endpoint must use the ws: protocol");
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!LOOPBACK_HOSTS.has(host)) {
        throw new TypeError("transcription endpoint must be a loopback address");
    }
    return parsed;
}
export function assertLoopbackBindHost(host) {
    const normalized = host.replace(/^\[|\]$/g, "");
    if (!LOOPBACK_HOSTS.has(normalized)) {
        throw new TypeError("transcription server must bind to a loopback address");
    }
}
