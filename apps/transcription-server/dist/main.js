import { assertLoopbackBindHost } from "@voice/streaming-protocol";
import { FakeRuntime } from "./fakeRuntime.js";
import { createTranscriptionGateway } from "./gateway.js";
function parsePort(value, fallback, name) {
    const parsed = Number(value ?? String(fallback));
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a nonnegative integer`);
    }
    return parsed;
}
function parseConfig() {
    const host = process.env.VOICE_HOST ?? "127.0.0.1";
    const port = parsePort(process.env.VOICE_PORT, 8787, "VOICE_PORT");
    const allowedOrigins = (process.env.VOICE_ALLOWED_ORIGINS ?? "http://localhost:5173")
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
    const capacity = parsePort(process.env.VOICE_MAX_SESSIONS, 1, "VOICE_MAX_SESSIONS");
    if (capacity < 1) {
        throw new Error("VOICE_MAX_SESSIONS must be a positive integer");
    }
    const fake = process.env.VOICE_FAKE_RUNTIME === "1";
    if (!fake) {
        if (!process.env.VOICE_MODEL_PATH || !process.env.VOICE_VAD_MODEL_PATH) {
            throw new Error("VOICE_MODEL_PATH and VOICE_VAD_MODEL_PATH are required");
        }
        throw new Error("native whisper runtime is not wired; set VOICE_FAKE_RUNTIME=1");
    }
    assertLoopbackBindHost(host);
    return { host, port, allowedOrigins, capacity };
}
async function main() {
    const config = parseConfig();
    const runtime = new FakeRuntime();
    const gateway = await createTranscriptionGateway({
        host: config.host,
        port: config.port,
        runtime,
        capacity: config.capacity,
        allowedOrigins: config.allowedOrigins,
    });
    console.error(`listening on ws://${config.host}:${gateway.port}`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
