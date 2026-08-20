import { describe, expect, it } from "vitest";

import { handleHttpRequest, loadServerEnv } from "../src/main.js";

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    VOICE_MODEL_PATH: "/models/ggml-small.bin",
    VOICE_VAD_MODEL_PATH: "/models/ggml-silero-v6.2.0.bin",
    VOICE_PORT: "8787",
    VOICE_ALLOWED_ORIGINS: "http://localhost:5173",
    VOICE_MAX_SESSIONS: "4",
    VOICE_BIND_HOST: "127.0.0.1",
    VOICE_AUTH_TOKEN: "secret-token",
    ...overrides,
  };
}

describe("loadServerEnv", () => {
  it("requires VOICE_AUTH_TOKEN when authentication is enabled", () => {
    expect(() => loadServerEnv(baseEnv({ VOICE_AUTH_TOKEN: undefined }))).toThrow(
      /VOICE_AUTH_TOKEN/,
    );
    expect(() => loadServerEnv(baseEnv({ VOICE_AUTH_TOKEN: "" }))).toThrow(/VOICE_AUTH_TOKEN/);
  });

  it("allows missing VOICE_AUTH_TOKEN only when auth is disabled on loopback", () => {
    const config = loadServerEnv(
      baseEnv({
        VOICE_REQUIRE_AUTH: "0",
        VOICE_AUTH_TOKEN: undefined,
        VOICE_BIND_HOST: "127.0.0.1",
      }),
    );
    expect(config.requireAuth).toBe(false);
  });

  it("rejects English-only quantized model paths", () => {
    expect(() => loadServerEnv(baseEnv({ VOICE_MODEL_PATH: "/models/ggml-small.en-q5_1.bin" }))).toThrow(
      /multilingual/,
    );
  });
});

describe("handleHttpRequest", () => {
  it("reports readiness only when the pool is warm", () => {
    const responses: Array<{ status: number; body: string }> = [];
    const response = {
      writeHead(status: number) {
        responses.push({ status, body: "" });
        return this;
      },
      end(body?: string) {
        const last = responses[responses.length - 1];
        if (last) last.body = body ?? "";
      },
    };

    handleHttpRequest(
      { method: "GET", url: "/health/ready" } as never,
      response as never,
      () => false,
    );
    handleHttpRequest(
      { method: "GET", url: "/health/ready" } as never,
      response as never,
      () => true,
    );
    handleHttpRequest({ method: "GET", url: "/" } as never, response as never, () => true);

    expect(responses.map((r) => r.status)).toEqual([503, 200, 404]);
    expect(JSON.parse(responses[0]!.body)).toEqual({ ready: false });
    expect(JSON.parse(responses[1]!.body)).toEqual({ ready: true });
  });
});
