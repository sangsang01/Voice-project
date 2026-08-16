import { EventEmitter } from "node:events";
import { decodePcmMessage, PCM_MESSAGE_BYTES } from "@voice/streaming-protocol";
import { describe, expect, it } from "vitest";

import { evaluateGates, runLocalBenchmark } from "../scripts/benchmark.mjs";

const SUBPROTOCOL = "voice-transcription.v1";
const CAPTION = "SECRET_CAPTION_MUST_NOT_APPEAR";

class MockSocket extends EventEmitter {
  public readonly sent: unknown[] = [];
  public readyState = 0;
  public url: string;
  public protocols: string | string[];
  public options: { origin?: string } | undefined;
  private pcmCount = 0;

  public constructor(
    url: string,
    protocols: string | string[],
    options: { origin?: string } | undefined,
    private readonly clock: { t: number },
    private readonly script: {
      firstPartialAtMs: number;
      refreshAtMs: number;
      finalAtMs: number;
      emitSecondPartial?: boolean;
    },
  ) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  public send(data: unknown): void {
    this.sent.push(data);
    queueMicrotask(() => this.respond(data));
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close", 1000);
  }

  private emitJson(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }

  private respond(data: unknown): void {
    if (typeof data === "string") {
      const parsed = JSON.parse(data) as { type?: string; request?: { sessionId: string } };
      if (parsed.type === "session.start") {
        this.emitJson({
          type: "session.accepted",
          sessionId: parsed.request?.sessionId,
          model: "ggml-small.bin",
          backend: "cpu",
        });
      }
      return;
    }

    const buffer = data instanceof ArrayBuffer ? data : Uint8Array.from(data as Buffer).buffer;
    const frame = decodePcmMessage(buffer);
    this.emitJson({
      type: "audio.ack",
      sessionId: "benchmark-1",
      throughSequence: frame.sequence,
    });
    this.pcmCount += 1;

    if (this.pcmCount === 1) {
      this.clock.t = this.script.firstPartialAtMs;
      this.emitJson({
        type: "engine.event",
        event: {
          type: "segment.upsert",
          sessionId: "benchmark-1",
          sequence: 1,
          segment: {
            id: "benchmark-1:0",
            ordinal: 0,
            revision: 0,
            startMs: 0,
            endMs: 400,
            text: CAPTION,
            language: { tag: "en-US" },
            isFinal: false,
          },
        },
      });
    }

    if (this.pcmCount === 2 && this.script.emitSecondPartial !== false) {
      this.clock.t = this.script.refreshAtMs;
      this.emitJson({
        type: "engine.event",
        event: {
          type: "segment.upsert",
          sessionId: "benchmark-1",
          sequence: 2,
          segment: {
            id: "benchmark-1:0",
            ordinal: 0,
            revision: 1,
            startMs: 0,
            endMs: 800,
            text: CAPTION,
            language: { tag: "en-US" },
            isFinal: false,
          },
        },
      });
    }

    if (this.pcmCount === 4) {
      this.clock.t = this.script.finalAtMs;
      this.emitJson({
        type: "engine.event",
        event: {
          type: "segment.upsert",
          sessionId: "benchmark-1",
          sequence: 3,
          segment: {
            id: "benchmark-1:0",
            ordinal: 0,
            revision: 2,
            startMs: 0,
            endMs: 1200,
            text: CAPTION,
            language: { tag: "en-US" },
            isFinal: true,
          },
        },
      });
    }
  }
}

function createDeps(script: {
  firstPartialAtMs: number;
  refreshAtMs: number;
  finalAtMs: number;
  emitSecondPartial?: boolean;
}) {
  const clock = { t: 0 };
  const logs: string[] = [];
  const files = new Map<string, string>();
  let socket: MockSocket | undefined;

  return {
    clock,
    logs,
    files,
    get socket() {
      return socket;
    },
    deps: {
      now: () => clock.t,
      sleep: async () => undefined,
      speechFrames: 3,
      silenceFrames: 1,
      resultsDir: "apps/transcription-server/benchmark-results",
      mkdirSync: () => undefined,
      writeFileSync: (path: string, data: string) => {
        files.set(path.replace(/\\/g, "/"), data);
      },
      log: (line: string) => {
        logs.push(line);
      },
      createWebSocket: (url: string, protocols: string | string[], options?: { origin?: string }) => {
        socket = new MockSocket(url, protocols, options, clock, script);
        return socket;
      },
    },
  };
}

describe("evaluateGates", () => {
  it("fails when firstPartialP95Ms exceeds 1500", () => {
    expect(
      evaluateGates({
        firstPartialP95Ms: 1501,
        refreshP95Ms: 10,
        finalAfterSilenceP95Ms: 10,
      }),
    ).toBe(false);
  });

  it("passes the 1.5s / 1s / 1.5s CPU gates", () => {
    expect(
      evaluateGates({
        firstPartialP95Ms: 1500,
        refreshP95Ms: 1000,
        finalAfterSilenceP95Ms: 1500,
      }),
    ).toBe(true);
  });
});

describe("runLocalBenchmark", () => {
  it("opens one loopback session, waits for audio.ack, and never logs caption text", async () => {
    const harness = createDeps({ firstPartialAtMs: 400, refreshAtMs: 900, finalAtMs: 1300 });
    const result = await runLocalBenchmark({
      ...harness.deps,
      model: "small",
      port: 8787,
    });

    expect(harness.socket?.url).toBe("ws://127.0.0.1:8787");
    expect(harness.socket?.protocols).toBe(SUBPROTOCOL);
    expect(harness.socket?.options?.origin).toBe("http://localhost:5173");

    const start = harness.socket?.sent.find((item) => typeof item === "string") as string;
    expect(JSON.parse(start).type).toBe("session.start");

    const pcm = (harness.socket?.sent ?? []).filter((item) => typeof item !== "string");
    expect(pcm.length).toBeGreaterThan(0);
    expect(new Uint8Array(pcm[0] as ArrayBuffer).byteLength).toBe(PCM_MESSAGE_BYTES);

    expect(result.sessions).toBe(1);
    expect(result.model).toBe("small");
    expect(result.backend).toBe("cpu");
    expect(result.loadCount).toBe(1);
    expect(result.firstPartialP95Ms).toBe(400);
    expect(result.refreshP95Ms).toBe(500);
    expect(result.finalAfterSilenceP95Ms).toBe(400);
    expect(result.passed).toBe(true);

    const printed = harness.logs.join("\n");
    expect(printed).toContain('"firstPartialP95Ms"');
    expect(printed).not.toContain(CAPTION);
    expect(JSON.stringify(result)).not.toContain(CAPTION);

    const written = [...harness.files.entries()];
    expect(written).toHaveLength(1);
    expect(written[0]?.[0]).toMatch(/apps\/transcription-server\/benchmark-results\//);
    expect(written[0]?.[1]).not.toContain(CAPTION);
  });

  it("returns passed=false when first partial is slower than 1500ms", async () => {
    const harness = createDeps({ firstPartialAtMs: 1800, refreshAtMs: 2000, finalAtMs: 2100 });
    const result = await runLocalBenchmark({
      ...harness.deps,
      model: "small",
    });
    expect(result.passed).toBe(false);
    expect(result.firstPartialP95Ms).toBe(1800);
  });

  it("fails the refresh gate when a first partial never gets a second revision", async () => {
    const harness = createDeps({
      firstPartialAtMs: 400,
      refreshAtMs: 900,
      finalAtMs: 1300,
      emitSecondPartial: false,
    });
    const result = await runLocalBenchmark({
      ...harness.deps,
      model: "small",
    });
    expect(result.firstPartialP95Ms).toBe(400);
    expect(result.refreshP95Ms).toBe(Number.POSITIVE_INFINITY);
    expect(result.passed).toBe(false);
    expect(harness.logs.join("\n")).not.toContain(CAPTION);
  });
});
